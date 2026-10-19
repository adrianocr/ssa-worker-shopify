import { env as workerEnv } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { defineTarget } from "../src/core/target";
import { fitMessage, MAX_ATTEMPTS, MAX_MESSAGE_BYTES, REFUND_WAIT_SECONDS } from "../src/core/queue";
import { log } from "../src/core/log";
import { addMissingColumns, STALE_CLAIM_MS } from "../src/core/store";
import { buildRefund } from "../src/targets/ga4-payload";
import { meta } from "../src/targets/meta";
import type { Logger, Order, QueueMessage, Refund } from "../src/core/types";
import {
  claimRows,
  collect,
  configWith,
  deliveries,
  failingDeliveriesDb,
  fakeTarget,
  fixtureOrder,
  fixtureRefund,
  makeEnv,
  purchaseMessage,
  refundMessage,
  runQueue,
  uniqueShop,
} from "./helpers";

describe("queue consumer", () => {
  it("joins identity by checkout token", async () => {
    const shop = uniqueShop();
    const target = fakeTarget("a");
    const config = configWith([target]);
    const { env } = makeEnv();
    const order = fixtureOrder(shop, { checkout_token: "tok-join" });
    await collect(config, env, { shop, checkoutToken: "tok-join", cookies: { _ga: "GA1.1.1.2" } });

    const { acked } = await runQueue(config, env, [purchaseMessage(order)]);
    expect(acked).toBe(1);
    expect(target.calls).toHaveLength(1);
    expect(target.calls[0]!.identity?.cookies._ga).toBe("GA1.1.1.2");
  });

  describe("identity binding", () => {
    // /collect is unauthenticated and order ids are guessable. A POST naming a real order id
    // must not attach the attacker's identity to that order.
    const attack = (shop: string, orderId: string) => ({
      shop,
      checkoutToken: "attacker-token",
      orderId,
      consent: { marketing: true },
      clickIds: { awc: "ATTACKER" },
    });

    it("ignores a /collect body that names the order id under another checkout token", async () => {
      const shop = uniqueShop();
      const marketing = fakeTarget("marketing", "marketing");
      const analytics = fakeTarget("analytics", "analytics");
      const config = configWith([marketing, analytics]);
      const { env } = makeEnv();
      const order = fixtureOrder(shop, { checkout_token: "real-token-never-reported" });
      await collect(config, env, attack(shop, order.id));

      await runQueue(config, env, [purchaseMessage(order)]);
      expect(marketing.calls).toHaveLength(0);
      expect(analytics.calls).toHaveLength(1);
      expect(analytics.calls[0]!.identity).toBeNull();
    });

    it("uses the real pixel row for the webhook's checkout token, not the attacker's", async () => {
      const shop = uniqueShop();
      const marketing = fakeTarget("marketing", "marketing");
      const config = configWith([marketing]);
      const { env } = makeEnv();
      const order = fixtureOrder(shop, { checkout_token: "real-token" });
      await collect(config, env, { shop, checkoutToken: "real-token", consent: { marketing: true }, clickIds: { awc: "REAL" } });
      await collect(config, env, attack(shop, order.id));

      await runQueue(config, env, [purchaseMessage(order)]);
      expect(marketing.calls).toHaveLength(1);
      expect(marketing.calls[0]!.identity?.clickIds.awc?.value).toBe("REAL");
    });

    it("gives a refund no identity when only the attacker's row names the order", async () => {
      const shop = uniqueShop();
      const marketing = fakeTarget("marketing", "marketing");
      const config = configWith([marketing]);
      const { env } = makeEnv();
      const order = fixtureOrder(shop, { checkout_token: "real-token-never-reported" });
      await runQueue(config, env, [purchaseMessage(order)]);
      await collect(config, env, attack(shop, order.id));

      await runQueue(config, env, [refundMessage(fixtureRefund(shop, { order_id: Number(order.id) }))]);
      expect(marketing.calls).toHaveLength(0);
    });

    it("gives a purchase without a checkout token no identity", async () => {
      const shop = uniqueShop();
      const target = fakeTarget("a");
      const config = configWith([target]);
      const { env } = makeEnv();
      const order = fixtureOrder(shop, { checkout_token: null });
      await collect(config, env, attack(shop, order.id));
      await runQueue(config, env, [purchaseMessage(order)]);
      expect(target.calls[0]!.identity).toBeNull();
    });
  });

  describe("consent", () => {
    it("runs analytics and skips marketing when there's no identity", async () => {
      const shop = uniqueShop();
      const analytics = fakeTarget("analytics", "analytics");
      const marketing = fakeTarget("marketing", "marketing");
      const config = configWith([analytics, marketing]);
      const { env } = makeEnv();
      await runQueue(config, env, [purchaseMessage(fixtureOrder(shop))]);
      expect(analytics.calls).toHaveLength(1);
      expect(analytics.calls[0]!.identity).toBeNull();
      expect(marketing.calls).toHaveLength(0);
    });

    it("skips both when consent is explicitly false", async () => {
      const shop = uniqueShop();
      const analytics = fakeTarget("analytics", "analytics");
      const marketing = fakeTarget("marketing", "marketing");
      const config = configWith([analytics, marketing]);
      const { env } = makeEnv();
      const order = fixtureOrder(shop);
      await collect(config, env, { shop, checkoutToken: order.checkoutToken, consent: { analytics: false, marketing: false } });
      await runQueue(config, env, [purchaseMessage(order)]);
      expect(analytics.calls).toHaveLength(0);
      expect(marketing.calls).toHaveLength(0);
      expect(await deliveries(shop)).toHaveLength(0);
    });

    it("runs marketing when consent is explicitly true", async () => {
      const shop = uniqueShop();
      const marketing = fakeTarget("marketing", "marketing");
      const config = configWith([marketing]);
      const { env } = makeEnv();
      const order = fixtureOrder(shop);
      await collect(config, env, { shop, checkoutToken: order.checkoutToken, consent: { marketing: true } });
      await runQueue(config, env, [purchaseMessage(order)]);
      expect(marketing.calls).toHaveLength(1);
    });
  });

  it("re-enqueues only the failing target and records the one that succeeded", async () => {
    const shop = uniqueShop();
    const ok = fakeTarget("ok");
    const flaky = fakeTarget("flaky", "analytics", { retryable: true });
    const config = configWith([ok, flaky]);
    const { env, sent } = makeEnv();
    const order = fixtureOrder(shop);

    const { acked } = await runQueue(config, env, [purchaseMessage(order)]);
    expect(acked).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ kind: "purchase", targets: ["flaky"], attempt: 2 });
    expect(sent[0]!.delaySeconds).toBeGreaterThan(0);
    expect(await deliveries(shop)).toEqual([{ kind: "purchase", ref_id: order.id, target: "ok" }]);

    // The retry only calls the failing target.
    await runQueue(config, env, [sent[0]!.body]);
    expect(ok.calls).toHaveLength(1);
    expect(flaky.calls).toHaveLength(2);
    expect(sent[1]!.body).toMatchObject({ targets: ["flaky"], attempt: 3 });
    expect(sent[1]!.delaySeconds).toBeGreaterThan(sent[0]!.delaySeconds!);
  });

  it("re-enqueues only the target whose claim failed, without calling it, and keeps the others recorded", async () => {
    const shop = uniqueShop();
    const ok = fakeTarget("ok");
    const bad = fakeTarget("bad");
    const config = configWith([ok, bad]);
    const { env, sent } = makeEnv({ DB: failingDeliveriesDb("bad") });
    const order = fixtureOrder(shop);

    const { acked } = await runQueue(config, env, [purchaseMessage(order)]);
    expect(acked).toBe(1);
    expect(ok.calls).toHaveLength(1);
    // The claim comes before the send, so nothing went out and the retry is safe.
    expect(bad.calls).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ kind: "purchase", targets: ["bad"], attempt: 2 });
    expect(await deliveries(shop)).toEqual([{ kind: "purchase", ref_id: order.id, target: "ok" }]);
  });

  it("doesn't record a send that returns { recorded: false }", async () => {
    const shop = uniqueShop();
    const debug = fakeTarget("debug", "analytics", undefined, { recorded: false });
    const config = configWith([debug]);
    const { env, sent } = makeEnv();
    const order = fixtureOrder(shop);

    await runQueue(config, env, [purchaseMessage(order)]);
    expect(debug.calls).toHaveLength(1);
    expect(sent).toHaveLength(0);
    expect(await deliveries(shop)).toHaveLength(0);

    // The same order can still go out later, for example after debug mode is switched off.
    // Fresh env: resolveShop memoizes per env object.
    const live = fakeTarget("debug");
    await runQueue(configWith([live]), makeEnv().env, [purchaseMessage(order)]);
    expect(live.calls).toHaveLength(1);
    expect(await deliveries(shop)).toEqual([{ kind: "purchase", ref_id: order.id, target: "debug" }]);
  });

  it("logs a deliberate skip at debug level, not as a debug or test send, and records nothing", async () => {
    const shop = uniqueShop();
    const skipper = fakeTarget("skipper", "analytics", undefined, { recorded: false, skipped: "no click id" });
    const tester = fakeTarget("tester", "analytics", undefined, { recorded: false });
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const { env, sent } = makeEnv();
      await runQueue(configWith([skipper, tester]), env, [purchaseMessage(fixtureOrder(shop))]);
      const target = (call: unknown[]) => (call[1] as { target?: string }).target;
      const debugLines = debugSpy.mock.calls.filter((c) => target(c) === "skipper").map((c) => c[0]);
      const infoLines = infoSpy.mock.calls.map((c) => [target(c), c[0]]);
      expect(debugLines).toEqual(["[ssa] skipped: no click id"]);
      expect(infoLines).toContainEqual(["tester", "[ssa] sent, not recorded (debug or test mode)"]);
      expect(infoLines.filter(([t]) => t === "skipper")).toEqual([]);
      expect(sent).toHaveLength(0);
      expect(await deliveries(shop)).toHaveLength(0);
    } finally {
      debugSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it("drops a non-retryable failure without re-enqueueing", async () => {
    const shop = uniqueShop();
    const broken = fakeTarget("broken", "analytics", { retryable: false });
    const { env, sent } = makeEnv();
    await runQueue(configWith([broken]), env, [purchaseMessage(fixtureOrder(shop))]);
    expect(broken.calls).toHaveLength(1);
    expect(sent).toHaveLength(0);
    expect(await deliveries(shop)).toHaveLength(0);
  });

  it(`gives up after ${MAX_ATTEMPTS} attempts`, async () => {
    const shop = uniqueShop();
    const flaky = fakeTarget("flaky", "analytics", { retryable: true });
    const { env, sent } = makeEnv();
    await runQueue(configWith([flaky]), env, [purchaseMessage(fixtureOrder(shop), { attempt: MAX_ATTEMPTS, targets: ["flaky"] })]);
    expect(flaky.calls).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });

  it("doesn't deliver a duplicate purchase twice", async () => {
    const shop = uniqueShop();
    const target = fakeTarget("a");
    const config = configWith([target]);
    const { env } = makeEnv();
    const order = fixtureOrder(shop);
    await runQueue(config, env, [purchaseMessage(order)]);
    await runQueue(config, env, [purchaseMessage(order)]);
    expect(target.calls).toHaveLength(1);
    expect(await deliveries(shop)).toHaveLength(1);
  });

  it("finds the refund's identity through the orders row written at purchase time", async () => {
    const shop = uniqueShop();
    const target = fakeTarget("a");
    const config = configWith([target]);
    const { env } = makeEnv();
    const order = fixtureOrder(shop, { checkout_token: "tok-refund" });
    // Only the orders table links the refund to this identity.
    await collect(config, env, { shop, checkoutToken: "tok-refund", cookies: { _ga: "GA1.1.5.6" } });

    await runQueue(config, env, [purchaseMessage(order)]);
    const refund = fixtureRefund(shop, {
      order_id: Number(order.id),
      transactions: [{ kind: "refund", status: "success", amount: "5.00" }],
      refund_line_items: [],
      total_duties_set: undefined,
    });
    expect(refund.currency).toBe("");
    await runQueue(config, env, [refundMessage(refund)]);

    const refundCall = target.calls.find((c) => c.kind === "refund");
    expect(refundCall?.identity?.cookies._ga).toBe("GA1.1.5.6");
    expect((await deliveries(shop)).map((d) => d.kind).sort()).toEqual(["purchase", "refund"]);
  });

  it("skips targets without refund support", async () => {
    const shop = uniqueShop();
    const purchaseOnly = { ...fakeTarget("p"), refund: undefined };
    const { env, sent } = makeEnv();
    const { acked } = await runQueue(configWith([purchaseOnly]), env, [refundMessage(fixtureRefund(shop), { attempt: 3 })]);
    expect(acked).toBe(1);
    expect(purchaseOnly.calls).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("never calls a target with missing required config", async () => {
    const shop = uniqueShop();
    let called = 0;
    const factory = defineTarget<{ apiKey: string; region?: string }>({
      id: "needs-key",
      consent: "analytics",
      required: ["apiKey"],
      async purchase() {
        called += 1;
      },
    });
    const target = factory({ apiKey: undefined, region: "eu" });
    expect(target.enabled).toBe(false);
    expect(target.missing).toEqual(["apiKey"]);
    expect(factory({ apiKey: "  " }).enabled).toBe(false);

    const { env, sent } = makeEnv();
    await runQueue(configWith([target]), env, [purchaseMessage(fixtureOrder(shop))]);
    expect(called).toBe(0);
    expect(sent).toHaveLength(0);
    expect(await deliveries(shop)).toHaveLength(0);
  });

  it("acks and drops malformed messages", async () => {
    const { env, sent } = makeEnv();
    const { acked } = await runQueue(configWith([fakeTarget("a")]), env, [{ nope: true } as never]);
    expect(acked).toBe(1);
    expect(sent).toHaveLength(0);
  });
  describe("a message that throws before any target runs", () => {
    it("re-enqueues it once through our own path and acks it", async () => {
      const shop = uniqueShop();
      const target = fakeTarget("a");
      const { env, sent } = makeEnv({ DB: failingDeliveriesDb(shop, "INTO orders") });
      const { acked } = await runQueue(configWith([target]), env, [purchaseMessage(fixtureOrder(shop))]);
      expect(acked).toBe(1);
      expect(target.calls).toHaveLength(0);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.body).toMatchObject({ kind: "purchase", attempt: 2 });
    });

    it("still acks it when logging throws after the re-enqueue, so the platform doesn't run it again", async () => {
      const shop = uniqueShop();
      const other = uniqueShop();
      const target = fakeTarget("a");
      // The root logger, not console: it holds the console functions it was created with.
      const warnSpy = vi.spyOn(log, "warn").mockImplementation((msg: string) => {
        if (msg === "message re-enqueued") throw new Error("log sink down");
      });
      try {
        const { env, sent } = makeEnv({ DB: failingDeliveriesDb(shop, "INTO orders") });
        const messages = [purchaseMessage(fixtureOrder(shop)), purchaseMessage(fixtureOrder(other))];
        const { acked, retried } = await runQueue(configWith([target]), env, messages);
        expect(acked).toBe(2);
        expect(retried).toHaveLength(0);
        expect(sent).toHaveLength(1);
        expect(sent[0]!.body).toMatchObject({ shop, attempt: 2 });
        // The rest of the batch still runs.
        expect(target.calls).toHaveLength(1);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("hands it back to the platform instead of acking when the re-enqueue fails too", async () => {
      const shop = uniqueShop();
      const { env, sent } = makeEnv({ DB: failingDeliveriesDb(shop, "INTO orders"), failQueue: true });
      const { acked, retried } = await runQueue(configWith([fakeTarget("a")]), env, [purchaseMessage(fixtureOrder(shop))]);
      expect(acked).toBe(0);
      expect(retried).toEqual([{ id: "m0", delaySeconds: 60 }]);
      expect(sent).toHaveLength(0);
    });

    it(`acks it without re-enqueueing at attempt ${MAX_ATTEMPTS}`, async () => {
      const shop = uniqueShop();
      const { env, sent } = makeEnv({ DB: failingDeliveriesDb(shop, "INTO orders"), failQueue: true });
      const { acked, retried } = await runQueue(configWith([fakeTarget("a")]), env, [
        purchaseMessage(fixtureOrder(shop), { attempt: MAX_ATTEMPTS }),
      ]);
      expect(acked).toBe(1);
      expect(retried).toHaveLength(0);
      expect(sent).toHaveLength(0);
    });
  });

  describe("logging that throws", () => {
    const throwing: Logger = {
      debug: () => {
        throw new Error("log sink down");
      },
      info: () => {
        throw new Error("log sink down");
      },
      warn: () => {
        throw new Error("log sink down");
      },
      error: () => {
        throw new Error("log sink down");
      },
      child: () => throwing,
    };

    /** Every child logger, the ones processMessage and deliver make included, throws on every call. */
    async function withThrowingChildren(run: () => Promise<void>) {
      const spy = vi.spyOn(log, "child").mockImplementation(() => throwing);
      try {
        await run();
      } finally {
        spy.mockRestore();
      }
    }

    it("re-enqueues a failed target exactly once and acks", async () => {
      await withThrowingChildren(async () => {
        const shop = uniqueShop();
        const ok = fakeTarget("ok");
        const flaky = fakeTarget("flaky", "analytics", { retryable: true });
        const { env, sent } = makeEnv();
        const { acked, retried } = await runQueue(configWith([ok, flaky]), env, [purchaseMessage(fixtureOrder(shop))]);
        expect(acked).toBe(1);
        expect(retried).toHaveLength(0);
        expect(sent).toHaveLength(1);
        expect(sent[0]!.body).toMatchObject({ targets: ["flaky"], attempt: 2 });
        expect(await deliveries(shop)).toEqual([expect.objectContaining({ target: "ok" })]);
      });
    });

    it("re-enqueues a refund waiting for its purchase exactly once and acks", async () => {
      await withThrowingChildren(async () => {
        const target = fakeTarget("a");
        const { env, sent } = makeEnv();
        const { acked, retried } = await runQueue(configWith([target]), env, [refundMessage(fixtureRefund(uniqueShop()))]);
        expect(acked).toBe(1);
        expect(retried).toHaveLength(0);
        expect(sent).toHaveLength(1);
        expect(sent[0]!.delaySeconds).toBe(REFUND_WAIT_SECONDS);
        expect(target.calls).toHaveLength(0);
      });
    });

    it("acks a delivered message without enqueueing anything", async () => {
      await withThrowingChildren(async () => {
        const shop = uniqueShop();
        const target = fakeTarget("a");
        const { env, sent } = makeEnv();
        const { acked, retried } = await runQueue(configWith([target]), env, [purchaseMessage(fixtureOrder(shop))]);
        expect(acked).toBe(1);
        expect(retried).toHaveLength(0);
        expect(sent).toHaveLength(0);
        expect(await deliveries(shop)).toEqual([expect.objectContaining({ target: "a" })]);
      });
    });

    it("acks a malformed message when the root logger throws", async () => {
      const spy = vi.spyOn(log, "error").mockImplementation(() => {
        throw new Error("log sink down");
      });
      try {
        const { env, sent } = makeEnv();
        const { acked, retried } = await runQueue(configWith([fakeTarget("a")]), env, [{ nope: true } as never]);
        expect(acked).toBe(1);
        expect(retried).toHaveLength(0);
        expect(sent).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("a per-target re-enqueue that fails", () => {
    /** A queue that fails every send and counts them. */
    function downQueue() {
      const send = vi.fn(async () => {
        throw new Error("queue down");
      });
      return { EVENTS: { send } as unknown as Queue<QueueMessage>, send };
    }

    it("hands the original message to the platform, without a whole-message re-enqueue", async () => {
      const shop = uniqueShop();
      const ok = fakeTarget("ok");
      const flaky = fakeTarget("flaky", "analytics", { retryable: true });
      const config = configWith([ok, flaky]);
      const order = fixtureOrder(shop);
      const { EVENTS, send } = downQueue();
      const { acked, retried } = await runQueue(config, makeEnv({ EVENTS }).env, [purchaseMessage(order)]);
      expect(send).toHaveBeenCalledTimes(1);
      expect(acked).toBe(0);
      expect(retried).toEqual([{ id: "m0", delaySeconds: 60 }]);

      // The redelivered original skips the target that's done and retries only the other.
      const { env, sent } = makeEnv();
      await runQueue(config, env, [purchaseMessage(order)]);
      expect(ok.calls).toHaveLength(1);
      expect(flaky.calls).toHaveLength(2);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.body).toMatchObject({ targets: ["flaky"], attempt: 2 });
    });

    it("doesn't lose a target waiting on a fresh claim: the redelivered copy waits again", async () => {
      const shop = uniqueShop();
      const target = fakeTarget("a");
      const config = configWith([target]);
      const order = fixtureOrder(shop);
      // Make sure the schema exists, then leave a fresh claim held by another consumer.
      await runQueue(configWith([]), makeEnv().env, [purchaseMessage(order)]);
      const recent = Date.now() - 60_000;
      await workerEnv.DB.prepare(
        `INSERT INTO deliveries (shop, kind, ref_id, target, delivered_at, state, claimed_at) VALUES (?, 'purchase', ?, 'a', ?, 'pending', ?)`,
      )
        .bind(shop, order.id, recent, recent)
        .run();

      const { EVENTS, send } = downQueue();
      const first = await runQueue(config, makeEnv({ EVENTS }).env, [purchaseMessage(order)]);
      expect(send).toHaveBeenCalledTimes(1);
      expect(first.retried).toEqual([{ id: "m0", delaySeconds: 60 }]);

      // 60 seconds later the claim is still fresh, so the redelivered copy waits past the stale window.
      const second = makeEnv();
      await runQueue(config, second.env, [purchaseMessage(order)]);
      expect(target.calls).toHaveLength(0);
      expect(second.sent).toHaveLength(1);
      expect(second.sent[0]!.delaySeconds).toBeGreaterThan(STALE_CLAIM_MS / 1000);

      // That copy arrives once the claim is stale, takes it over and sends once.
      const old = Date.now() - STALE_CLAIM_MS - 1000;
      await workerEnv.DB.prepare("UPDATE deliveries SET claimed_at = ? WHERE shop = ?").bind(old, shop).run();
      const third = makeEnv();
      await runQueue(config, third.env, [second.sent[0]!.body]);
      expect(target.calls).toHaveLength(1);
      expect(third.sent).toHaveLength(0);
      expect(await claimRows(shop)).toEqual([expect.objectContaining({ target: "a", state: "done" })]);
    });
  });

  describe("delivery claims", () => {
    function gatedTarget(id: string) {
      const target = fakeTarget(id);
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const purchase = target.purchase.bind(target);
      target.purchase = async (order, identity, ctx) => {
        const result = await purchase(order, identity, ctx);
        await gate;
        return result;
      };
      return { target, open };
    }

    it("sends once when two copies of the same message run at the same time", async () => {
      const shop = uniqueShop();
      const { target, open } = gatedTarget("a");
      const config = configWith([target]);
      const { env, sent } = makeEnv();
      const order = fixtureOrder(shop);
      const first = runQueue(config, env, [purchaseMessage(order)]);
      const second = runQueue(config, env, [purchaseMessage(order)]);
      // Let both reach the claim before the first send finishes.
      await vi.waitFor(() => expect(target.calls.length).toBeGreaterThan(0));
      await new Promise((r) => setTimeout(r, 50));
      open();
      await Promise.all([first, second]);
      expect(target.calls).toHaveLength(1);
      expect(await claimRows(shop)).toEqual([expect.objectContaining({ target: "a", state: "done" })]);
      // The copy that found the claim comes back after the stale window, sees done and stops.
      expect(sent).toHaveLength(1);
      expect(sent[0]!.delaySeconds).toBeGreaterThan(STALE_CLAIM_MS / 1000);
      const later = makeEnv();
      await runQueue(config, later.env, [sent[0]!.body]);
      expect(target.calls).toHaveLength(1);
      expect(later.sent).toHaveLength(0);
    });

    it("doesn't re-send when marking done fails after a successful send", async () => {
      const shop = uniqueShop();
      const target = fakeTarget("a");
      const config = configWith([target]);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const { env, sent } = makeEnv({ DB: failingDeliveriesDb("a", "SET state = 'done'") });
        const order = fixtureOrder(shop);
        await runQueue(config, env, [purchaseMessage(order)]);
        expect(target.calls).toHaveLength(1);
        expect(sent).toHaveLength(0);
        expect(errorSpy.mock.calls.map((c) => c[0])).toContain("[ssa] sent, but marking it delivered failed; not retrying");
        // The pending claim stays, so a duplicate webhook doesn't send now; it waits out the window.
        expect(await claimRows(shop)).toEqual([expect.objectContaining({ target: "a", state: "pending" })]);
        const duplicate = makeEnv();
        await runQueue(config, duplicate.env, [purchaseMessage(order)]);
        expect(target.calls).toHaveLength(1);
        expect(duplicate.sent[0]!.delaySeconds).toBeGreaterThan(STALE_CLAIM_MS / 1000);
      } finally {
        errorSpy.mockRestore();
      }
    });

    it("drops the claim on a failed send so the retry sends", async () => {
      const shop = uniqueShop();
      let fail = true;
      const target = fakeTarget("a");
      const purchase = target.purchase.bind(target);
      target.purchase = async (order, identity, ctx) => {
        await purchase(order, identity, ctx);
        if (fail) throw new Error("network");
      };
      const config = configWith([target]);
      const { env, sent } = makeEnv();
      await runQueue(config, env, [purchaseMessage(fixtureOrder(shop))]);
      expect(await claimRows(shop)).toEqual([]);
      expect(sent).toHaveLength(1);

      fail = false;
      await runQueue(config, env, [sent[0]!.body]);
      expect(target.calls).toHaveLength(2);
      expect(await deliveries(shop)).toHaveLength(1);
    });

    it("waits out a fresh pending claim left by a failed release, then takes it over and sends once", async () => {
      const shop = uniqueShop();
      let fail = true;
      const target = fakeTarget("a");
      const purchase = target.purchase.bind(target);
      target.purchase = async (order, identity, ctx) => {
        await purchase(order, identity, ctx);
        if (fail) throw new Error("network");
      };
      const config = configWith([target]);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        // The send fails and dropping the claim fails too, so a fresh pending row stays behind.
        const failing = makeEnv({ DB: failingDeliveriesDb("a", "DELETE FROM deliveries") });
        const order = fixtureOrder(shop);
        await runQueue(config, failing.env, [purchaseMessage(order)]);
        expect(target.calls).toHaveLength(1);
        expect(failing.sent).toHaveLength(1);
        expect(await claimRows(shop)).toEqual([expect.objectContaining({ target: "a", state: "pending" })]);

        // The retry finds that claim, doesn't send, and comes back after the stale window.
        fail = false;
        const second = makeEnv();
        await runQueue(config, second.env, [failing.sent[0]!.body]);
        expect(target.calls).toHaveLength(1);
        expect(second.sent).toHaveLength(1);
        expect(second.sent[0]!.delaySeconds).toBeGreaterThan(STALE_CLAIM_MS / 1000);
        expect(second.sent[0]!.body).toMatchObject({ targets: ["a"], attempt: 3 });

        // That attempt arrives once the claim has gone stale, takes it over and sends exactly once.
        const old = Date.now() - STALE_CLAIM_MS - 1000;
        await workerEnv.DB.prepare("UPDATE deliveries SET claimed_at = ?, delivered_at = ? WHERE shop = ?").bind(old, old, shop).run();
        const third = makeEnv();
        await runQueue(config, third.env, [second.sent[0]!.body]);
        expect(target.calls).toHaveLength(2);
        expect(third.sent).toHaveLength(0);
        expect(await claimRows(shop)).toEqual([expect.objectContaining({ target: "a", state: "done" })]);
      } finally {
        errorSpy.mockRestore();
      }
    });

    it("skips a target whose delivery is already done without re-enqueueing", async () => {
      const shop = uniqueShop();
      const target = fakeTarget("a");
      const config = configWith([target]);
      const order = fixtureOrder(shop);
      await runQueue(config, makeEnv().env, [purchaseMessage(order)]);
      const { env, sent } = makeEnv();
      await runQueue(config, env, [purchaseMessage(order)]);
      expect(target.calls).toHaveLength(1);
      expect(sent).toHaveLength(0);
    });

    it("takes over a pending claim older than 10 minutes and leaves a fresh one alone", async () => {
      const stale = uniqueShop();
      const fresh = uniqueShop();
      const target = fakeTarget("a");
      const config = configWith([target]);
      const { env } = makeEnv();
      const staleOrder = fixtureOrder(stale);
      const freshOrder = fixtureOrder(fresh);
      // Make sure the schema (with the claim columns) exists before writing rows by hand.
      await runQueue(configWith([]), env, [purchaseMessage(staleOrder)]);
      const insert = `INSERT INTO deliveries (shop, kind, ref_id, target, delivered_at, state, claimed_at) VALUES (?, 'purchase', ?, 'a', ?, 'pending', ?)`;
      const old = Date.now() - STALE_CLAIM_MS - 60_000;
      const recent = Date.now() - 60_000;
      await workerEnv.DB.prepare(insert).bind(stale, staleOrder.id, old, old).run();
      await workerEnv.DB.prepare(insert).bind(fresh, freshOrder.id, recent, recent).run();

      // A new env: resolveShop memoizes the shop's config per env object.
      await runQueue(config, makeEnv().env, [purchaseMessage(staleOrder), purchaseMessage(freshOrder)]);
      expect(target.calls.map((c) => c.ref)).toEqual([staleOrder.id]);
      expect(await claimRows(stale)).toEqual([expect.objectContaining({ state: "done" })]);
      expect(await claimRows(fresh)).toEqual([expect.objectContaining({ state: "pending", claimed_at: recent })]);
    });

    it("adds the new columns to a table in the old shape, once, and old rows read as done", async () => {
      const table = `legacy_deliveries_${Date.now().toString(36)}`;
      await workerEnv.DB.prepare(
        `CREATE TABLE ${table} (shop TEXT NOT NULL, kind TEXT NOT NULL, ref_id TEXT NOT NULL, target TEXT NOT NULL,
         delivered_at INTEGER NOT NULL, PRIMARY KEY (shop, kind, ref_id, target))`,
      ).run();
      await workerEnv.DB.prepare(`INSERT INTO ${table} VALUES ('s', 'purchase', '1', 'ga4', 1)`).run();
      const columns: [string, string][] = [
        ["state", "TEXT NOT NULL DEFAULT 'done'"],
        ["claimed_at", "INTEGER"],
      ];
      await addMissingColumns(workerEnv.DB, table, columns);
      // A second run (another isolate, or the next cold start) is a no-op.
      await addMissingColumns(workerEnv.DB, table, columns);
      const row = await workerEnv.DB.prepare(`SELECT state, claimed_at FROM ${table}`).first();
      expect(row).toEqual({ state: "done", claimed_at: null });
      await workerEnv.DB.prepare(`DROP TABLE ${table}`).run();
    });
  });

  describe("test orders", () => {
    it("skips every target for a test order by default and logs it at info", async () => {
      const shop = uniqueShop();
      const target = fakeTarget("a");
      const infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        const { env, sent } = makeEnv();
        await runQueue(configWith([target]), env, [purchaseMessage(fixtureOrder(shop, { test: true }))]);
        expect(target.calls).toHaveLength(0);
        expect(sent).toHaveLength(0);
        expect(infoSpy.mock.calls.map((c) => c[0])).toContain("[ssa] skipped: test order");
      } finally {
        infoSpy.mockRestore();
      }
    });

    it("sends test orders when SEND_TEST_ORDERS is true", async () => {
      const shop = uniqueShop();
      const target = fakeTarget("a");
      const { env } = makeEnv({ SEND_TEST_ORDERS: "true" });
      await runQueue(configWith([target]), env, [purchaseMessage(fixtureOrder(shop, { test: true }))]);
      expect(target.calls).toHaveLength(1);
    });

    it("skips the refund of a test order through the stored orders row", async () => {
      const shop = uniqueShop();
      const target = fakeTarget("a");
      const config = configWith([target]);
      const { env, sent } = makeEnv();
      const order = fixtureOrder(shop, { test: true });
      await runQueue(config, env, [purchaseMessage(order)]);
      await runQueue(config, env, [refundMessage(fixtureRefund(shop, { order_id: Number(order.id) }))]);
      expect(target.calls).toHaveLength(0);
      expect(sent).toHaveLength(0);
    });
  });

  describe("order sources", () => {
    it("sends only web orders by default and skips others with an info log", async () => {
      const shop = uniqueShop();
      const target = fakeTarget("a");
      const infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        const { env } = makeEnv();
        const pos = fixtureOrder(shop, { source_name: "pos" });
        const web = fixtureOrder(shop, { id: 1234, source_name: "web" });
        await runQueue(configWith([target]), env, [purchaseMessage(pos), purchaseMessage(web)]);
        expect(target.calls.map((c) => c.ref)).toEqual(["1234"]);
        expect(infoSpy.mock.calls.map((c) => c[0])).toContain("[ssa] skipped: source pos");
      } finally {
        infoSpy.mockRestore();
      }
    });

    it("honors an ORDER_SOURCES list, case-insensitively, and * for all", async () => {
      const shop = uniqueShop();
      const listed = fakeTarget("a");
      await runQueue(configWith([listed]), makeEnv({ ORDER_SOURCES: " Web, POS " }).env, [
        purchaseMessage(fixtureOrder(shop, { source_name: "pos" })),
        purchaseMessage(fixtureOrder(shop, { id: 2, source_name: "shopify_draft_order" })),
      ]);
      expect(listed.calls.map((c) => c.ref)).toEqual([fixtureOrder(shop).id]);

      const all = fakeTarget("b");
      await runQueue(configWith([all]), makeEnv({ ORDER_SOURCES: "*" }).env, [
        purchaseMessage(fixtureOrder(uniqueShop(), { source_name: "shopify_draft_order" })),
      ]);
      expect(all.calls).toHaveLength(1);
    });

    it("sends an order without a source_name", async () => {
      const target = fakeTarget("a");
      const order = fixtureOrder(uniqueShop());
      delete order.sourceName;
      await runQueue(configWith([target]), makeEnv().env, [purchaseMessage(order)]);
      expect(target.calls).toHaveLength(1);
    });

    it("skips a refund when its order's source was filtered out", async () => {
      const shop = uniqueShop();
      const target = fakeTarget("a");
      const config = configWith([target]);
      const { env } = makeEnv();
      const order = fixtureOrder(shop, { source_name: "pos" });
      await runQueue(config, env, [purchaseMessage(order)]);
      await runQueue(config, env, [refundMessage(fixtureRefund(shop, { order_id: Number(order.id) }))]);
      expect(target.calls).toHaveLength(0);
    });
  });

  describe("refunds", () => {
    it("skips a refund with nothing refunded for every target", async () => {
      const shop = uniqueShop();
      const target = fakeTarget("a");
      const infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        const { env, sent } = makeEnv();
        const refund = fixtureRefund(shop, { transactions: [{ kind: "refund", status: "pending", amount: "26.95" }] });
        expect(refund.amount).toBe(0);
        await runQueue(configWith([target]), env, [refundMessage(refund)]);
        expect(target.calls).toHaveLength(0);
        expect(sent).toHaveLength(0);
        expect(infoSpy.mock.calls.map((c) => c[0])).toContain("[ssa] skipped: nothing refunded");
      } finally {
        infoSpy.mockRestore();
      }
    });

    it("waits for the purchase when the refund comes first, then goes ahead without identity", async () => {
      const shop = uniqueShop();
      const target = fakeTarget("a");
      const config = configWith([target]);
      const { env, sent } = makeEnv();
      const refund = fixtureRefund(shop, { order_id: 987654 });
      await runQueue(config, env, [refundMessage(refund)]);
      expect(target.calls).toHaveLength(0);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.delaySeconds).toBe(REFUND_WAIT_SECONDS);
      expect(sent[0]!.body).toMatchObject({ kind: "refund", attempt: 2 });

      await runQueue(config, env, [sent[0]!.body]);
      expect(sent).toHaveLength(2);
      expect(sent[1]!.body).toMatchObject({ attempt: 3 });

      await runQueue(config, env, [sent[1]!.body]);
      expect(target.calls).toHaveLength(1);
      expect(target.calls[0]!.identity).toBeNull();
      expect(sent).toHaveLength(2);
    });

    it("goes ahead at once when the purchase is already stored", async () => {
      const shop = uniqueShop();
      const target = fakeTarget("a");
      const config = configWith([target]);
      const { env, sent } = makeEnv();
      const order = fixtureOrder(shop);
      await runQueue(config, env, [purchaseMessage(order)]);
      await runQueue(config, env, [refundMessage(fixtureRefund(shop, { order_id: Number(order.id) }))]);
      expect(target.calls.map((c) => c.kind)).toEqual(["purchase", "refund"]);
      expect(sent).toHaveLength(0);
    });
  });

  describe("message size", () => {
    function bigOrder(lines: number): Order {
      const order = fixtureOrder(uniqueShop());
      order.lines = Array.from({ length: lines }, (_, i) => ({
        id: String(14800000000000 + i),
        productId: String(8030000000000 + i),
        variantId: String(44100000000000 + i),
        sku: `SKU-${i}-${"x".repeat(20)}`,
        title: `Product number ${i} with a reasonably long title`,
        variantTitle: "Large / Blue",
        vendor: "Example Goods",
        price: 19.99,
        quantity: 1,
        discount: 0,
      }));
      return order;
    }

    it("cuts lines from a message over 100 KB, keeps the totals and flags it", async () => {
      const order = bigOrder(1000);
      const message = purchaseMessage(order);
      expect(new TextEncoder().encode(JSON.stringify(message)).byteLength).toBeGreaterThan(MAX_MESSAGE_BYTES);
      // The root logger, not console: it holds the console functions it was created with.
      const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
      try {
        const { env, sent } = makeEnv();
        const target = fakeTarget("flaky", "analytics", { retryable: true });
        await runQueue(configWith([target]), env, [message]);
        expect(sent).toHaveLength(1);
        const body = sent[0]!.body as { order: Order };
        expect(new TextEncoder().encode(JSON.stringify(sent[0]!.body)).byteLength).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
        expect(body.order.linesTruncated).toBe(true);
        expect(body.order.lines.length).toBeGreaterThan(0);
        expect(body.order.lines.length).toBeLessThan(1000);
        expect(body.order.total).toBe(order.total);
        expect(warnSpy.mock.calls.map((c) => c[0])).toContain("queue message too large, lines truncated");
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("leaves a normal message alone", () => {
      const message = purchaseMessage(fixtureOrder(uniqueShop()));
      expect(fitMessage(message)).toBe(message);
    });

    it("keeps the GA4 refund value whole when a refund of ~3000 lines is cut", () => {
      const lineItems = Array.from({ length: 3000 }, (_, i) => ({
        quantity: 1,
        subtotal: 1.25,
        subtotal_set: { shop_money: { amount: "1.25", currency_code: "USD" } },
        line_item: { title: `Refunded thing ${i}`, sku: `SKU-${i}-${"y".repeat(20)}`, variant_id: 44100000000000 + i },
      }));
      const refund = fixtureRefund(uniqueShop(), { refund_line_items: lineItems });
      const fitted = fitMessage(refundMessage(refund)) as { refund: Refund };
      expect(fitted.refund.linesTruncated).toBe(true);
      expect(fitted.refund.lines.length).toBeLessThan(3000);
      const params = buildRefund(fitted.refund, null).events[0]!.params as { value: number; items: unknown[] };
      expect(params.value).toBe(3750);
      expect(params.items.length).toBe(fitted.refund.lines.length);
    });

    it("keeps Meta's num_items whole when order lines are cut", async () => {
      const lineItems = Array.from({ length: 1000 }, (_, i) => ({
        id: 14800000000000 + i,
        variant_id: 44100000000000 + i,
        sku: `SKU-${i}-${"x".repeat(20)}`,
        title: `Product number ${i} with a reasonably long title`,
        price: "19.99",
        quantity: 2,
      }));
      const order = fixtureOrder(uniqueShop(), { line_items: lineItems, created_at: new Date().toISOString() });
      const fitted = fitMessage(purchaseMessage(order)) as { order: Order };
      expect(fitted.order.linesTruncated).toBe(true);
      let body: { data: { custom_data: { num_items: number; contents: unknown[] } }[] } | undefined;
      const fetchStub = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return new Response("{}", { status: 200 });
      }) as typeof fetch;
      await meta({ pixelId: "1", accessToken: "t" }).purchase(fitted.order, null, { shop: order.shop, log, fetch: fetchStub });
      expect(body!.data[0]!.custom_data.contents.length).toBe(fitted.order.lines.length);
      expect(body!.data[0]!.custom_data.num_items).toBe(2000);
    });

    it("falls back to the lines for messages without Refund.linesAmount or Order.itemCount", async () => {
      // Messages queued by older versions carry neither field.
      const refund = fixtureRefund(uniqueShop());
      refund.lines = [
        { sku: "A", title: "A", quantity: 1, amount: 10.5 },
        { sku: "B", title: "B", quantity: 2, amount: 4.25 },
      ];
      delete refund.linesAmount;
      const params = buildRefund(refund, null).events[0]!.params as { value: number };
      expect(params.value).toBe(14.75);

      const order = fixtureOrder(uniqueShop(), { created_at: new Date().toISOString() });
      delete order.itemCount;
      const quantity = order.lines.reduce((n, l) => n + l.quantity, 0);
      expect(quantity).toBeGreaterThan(0);
      let body: { data: { custom_data: { num_items: number } }[] } | undefined;
      const fetchStub = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return new Response("{}", { status: 200 });
      }) as typeof fetch;
      await meta({ pixelId: "1", accessToken: "t" }).purchase(order, null, { shop: order.shop, log, fetch: fetchStub });
      expect(body!.data[0]!.custom_data.num_items).toBe(quantity);
    });

    it("cuts refund lines too", () => {
      const refund: Refund = fixtureRefund(uniqueShop());
      refund.lines = Array.from({ length: 2000 }, (_, i) => ({ sku: `SKU-${i}-${"y".repeat(40)}`, title: "Refunded thing", quantity: 1, amount: 1 }));
      const fitted = fitMessage(refundMessage(refund)) as { refund: Refund };
      expect(fitted.refund.linesTruncated).toBe(true);
      expect(fitted.refund.amount).toBe(refund.amount);
    });
  });
});
