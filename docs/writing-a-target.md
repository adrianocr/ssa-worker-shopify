# Writing a target

A target sends one kind of event to one destination. It's a single file. You don't touch the queue, retries, consent or storage code.

## The contract

From `src/core/types.ts`:

```ts
export interface DeliveryResult {
  recorded: boolean;
  /** Set when nothing was sent on purpose. The consumer logs the reason at debug level. */
  skipped?: string;
}

export interface Target {
  id: string;
  consent: ConsentCategory; // "analytics" | "marketing" | "preferences" | "sale_of_data"
  enabled: boolean;
  missing: string[];
  purchase(order: Order, identity: Identity | null, ctx: TargetContext): Promise<void | DeliveryResult>;
  refund?(refund: Refund, identity: Identity | null, ctx: TargetContext): Promise<void | DeliveryResult>;
}

export interface TargetContext {
  shop: string;
  log: Logger;
  fetch: typeof fetch;
}
```

You don't build a `Target` by hand. `defineTarget` in `src/core/target.ts` does it:

```ts
defineTarget<C>({
  id: string,
  consent: ConsentCategory,
  required: (keyof C)[],
  purchase(order, identity, config: C, ctx): Promise<void | DeliveryResult>,
  refund?(refund, identity, config: C, ctx): Promise<void | DeliveryResult>,
}): (config: { [K in keyof C]?: C[K] }) => Target
```

`C` is your config shape. The factory it returns takes every field as optional, because the values come straight from env vars and may be undefined. If any field named in `required` is missing or blank, the target comes back with `enabled: false` and the missing names. The worker logs that once and never calls it. Inside `purchase` and `refund` you get a fully populated `C`.

Return normally and the worker marks the event delivered. Throw and it doesn't.

If your target has a debug or test mode (a validation endpoint, a test flag the destination ignores), return `{ recorded: false }` from that send. The worker then skips the `deliveries` row, so the real send of the same event can still happen later. GA4 does this in debug mode, Meta with a test event code, Awin with `test`:

```ts
await sendJson(ctx, url, { body });
return config.test ? { recorded: false } : undefined;
```

The data you get is in `src/core/types.ts`: `Order` (totals as numbers in shop currency, `lines`, `customer`, `createdAt`, and the order's own `browserIp` and `userAgent`), `Refund`, and `Identity` (cookies, click ids with first-seen time, consent, IP, user agent, page URL). `identity` is `null` when the pixel never reported for this order, so handle that.

## A complete example

A made-up target that posts purchases to a webhook URL. Save it as `src/targets/example.ts`:

```ts
import { sendJson } from "../core/http";
import { defineTarget } from "../core/target";

export interface ExampleConfig {
  endpoint: string;
  token: string;
  /** Sent as a label on every event. */
  source?: string;
}

export const example = defineTarget<ExampleConfig>({
  id: "example",
  consent: "analytics",
  required: ["endpoint", "token"],

  async purchase(order, identity, config, ctx) {
    await sendJson(ctx, config.endpoint, {
      headers: { Authorization: `Bearer ${config.token}` },
      body: {
        source: config.source ?? "shopify",
        orderId: order.id,
        value: order.total,
        currency: order.currency,
        items: order.lines.map((l) => ({ sku: l.sku, quantity: l.quantity, price: l.price })),
        clientId: identity?.cookies._ga,
      },
    });
    ctx.log.info("example: purchase sent", { orderId: order.id });
  },

  async refund(refund, _identity, config, ctx) {
    await sendJson(ctx, config.endpoint, {
      headers: { Authorization: `Bearer ${config.token}` },
      body: { orderId: refund.orderId, refundId: refund.id, value: -refund.amount, currency: refund.currency },
    });
  },
});
```

Leave out `refund` if the destination has no way to take one. The worker skips refunds for targets without it.

`sendJson` (in `src/core/http.ts`) does the POST, a 10 second timeout, and turns bad responses into `TargetError`s for you. It cancels the body of a 2xx response; pass `readBody: true` if you need to read it.

Test orders, orders from sources outside `ORDER_SOURCES`, and refunds with nothing refunded never reach a target, so you don't check for them. `lines` can be cut short on an order or refund with thousands of lines (`linesTruncated` is then set). The totals, `Order.itemCount` and `Refund.linesAmount` are computed from every line before that, so they're always complete. Use them instead of summing `lines`. Use `ctx.fetch` directly only if you need something it doesn't do, and then throw `TargetError` yourself.

## Wire it in

Two small edits.

1. Import it in `src/config.ts` from its own file and add one entry to the array, mapping env vars to its config:

   ```ts
   import { example } from "./targets/example";

   // inside targets: [ ... ]
   example({ endpoint: vars.EXAMPLE_ENDPOINT, token: vars.EXAMPLE_TOKEN }),
   ```

2. Add the variables to `.dev.vars.example`, the README's variable tables, and a page under `docs/targets/`.

## Errors

Throw `TargetError` from `src/core/target.ts`:

```ts
throw new TargetError("HTTP 400: bad currency", false); // final: logged, not retried
throw new TargetError("HTTP 503", true);                // retried with backoff, up to 8 attempts
```

`sendJson` already picks the right one: network errors, timeouts, 429 and 5xx are retryable, other statuses aren't. Any error that isn't a `TargetError` is treated as retryable. A retry only re-runs your target, not the others.

To skip an event on purpose (the Awin target does it when there's no `awc`), return `{ recorded: false, skipped: "<short reason>" }`. Nothing was sent, so the event isn't marked delivered, and the worker logs `skipped: <short reason>` at debug level instead of `sent, not recorded (debug or test mode)`. Returning nothing marks it delivered.

## Choosing the consent category

Pick the category that matches what the destination does with the data.

- `analytics`: measurement only (GA4, sGTM). When consent is unknown, the worker still sends.
- `marketing`: ad platforms that use the data for targeting or attribution (Meta, Awin). When consent is unknown, the worker skips.
- `preferences`, `sale_of_data`: available if the destination fits. Both skip when unknown.

If you send hashed customer details to an ad network, it's `marketing`. When unsure, choose the stricter one.

## Testing

Targets are tested with a fake `fetch`, no network. Copy the setup from `test/targets/awin.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { TargetError } from "../../src/core/target";
import type { Logger, TargetContext } from "../../src/core/types";
import { example } from "../../src/targets/example";
import { fixtureOrder } from "../helpers";

function makeCtx(respond: () => Response = () => new Response("{}", { status: 200 })) {
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => respond());
  const log: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log };
  const ctx: TargetContext = { shop: "s.myshopify.com", log, fetch: fetchMock as unknown as typeof fetch };
  return { ctx, fetchMock };
}

describe("example target", () => {
  it("is disabled without a token", () => {
    const t = example({ endpoint: "https://hooks.example.com/x" });
    expect(t.enabled).toBe(false);
    expect(t.missing).toEqual(["token"]);
  });

  it("posts the order", async () => {
    const { ctx, fetchMock } = makeCtx();
    const t = example({ endpoint: "https://hooks.example.com/x", token: "t" });
    await t.purchase(fixtureOrder("s.myshopify.com"), null, ctx);
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.currency).toBeTypeOf("string");
  });

  it("marks a 400 as final", async () => {
    const { ctx } = makeCtx(() => new Response("bad", { status: 400 }));
    const t = example({ endpoint: "https://hooks.example.com/x", token: "t" });
    const err = await t.purchase(fixtureOrder("s.myshopify.com"), null, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(TargetError);
    expect(err.retryable).toBe(false);
  });
});
```

`test/helpers.ts` also has `fixtureOrder`, `fixtureRefund`, `fakeTarget` and the worker-level helpers (`webhook`, `collect`, `runQueue`) for tests that go through the whole pipeline. Run `npm test` and `npm run typecheck` before you open a PR.
