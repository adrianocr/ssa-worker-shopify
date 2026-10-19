import { env, exports } from "cloudflare:workers";
import { createExecutionContext, createScheduledController } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import config from "../src/config";
import { resolveShop } from "../src/core/config";
import { openStore } from "../src/core/store";
import worker from "../src/index";
import { fixtureOrder, makeEnv, uniqueShop } from "./helpers";

describe("worker entry", () => {
  it("answers the health check through the real binding setup", async () => {
    const res = await exports.default.fetch("https://worker.test/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("ssa-worker-shopify");
  });

  it("cleanup removes stale identities without an orders row and keeps linked ones", async () => {
    const shop = uniqueShop();
    const store = await openStore(env.DB);
    const identity = { cookies: {}, clickIds: {}, consent: {}, collectedAt: 0 };
    await store.putIdentity(shop, "stale", identity);
    await store.putIdentity(shop, "pixel-order-id-only", identity);
    await store.putIdentity(shop, "linked-by-order", identity);
    await store.putIdentity(shop, "fresh", identity);
    // An order_id on the identity row (written by older versions) no longer keeps it alive.
    await env.DB.prepare("UPDATE identities SET order_id = '1' WHERE shop = ? AND checkout_token = 'pixel-order-id-only'").bind(shop).run();
    await store.putOrder(shop, "2", "linked-by-order", "USD", new Date().toISOString());
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await env.DB.prepare("UPDATE identities SET updated_at = ? WHERE shop = ? AND checkout_token != 'fresh'").bind(eightDaysAgo, shop).run();

    await worker.scheduled!(createScheduledController(), env as never, createExecutionContext());

    const { results } = await env.DB.prepare("SELECT checkout_token FROM identities WHERE shop = ? ORDER BY checkout_token")
      .bind(shop)
      .all<{ checkout_token: string }>();
    expect(results.map((r) => r.checkout_token)).toEqual(["fresh", "linked-by-order"]);
  });
});

describe("src/config.ts with stub targets", () => {
  it("disables every target when its keys are unset", () => {
    const { env: testEnv } = makeEnv();
    const shop = resolveShop(config, testEnv, uniqueShop())!;
    expect(shop.targets).toEqual([]);
  });

  it("enables targets whose required keys are set", () => {
    const { env: testEnv } = makeEnv({
      GA4_MEASUREMENT_ID: "G-TEST",
      GA4_API_SECRET: "x",
      SGTM_URL: "https://sgtm.example.com/mp/collect",
      META_PIXEL_ID: "1",
      META_ACCESS_TOKEN: "x",
      AWIN_ADVERTISER_ID: "1",
      AWIN_API_KEY: "x",
    });
    const shop = resolveShop(config, testEnv, uniqueShop())!;
    expect(shop.targets.map((t) => [t.id, t.consent])).toEqual([
      ["ga4", "analytics"],
      ["sgtm", "analytics"],
      ["meta", "marketing"],
      ["awin", "marketing"],
    ]);
  });

  it("wires META_API_VERSION, META_CONTENT_ID and AWIN_TEST", async () => {
    const seen: { url: string; body: any }[] = [];
    const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const { env: testEnv } = makeEnv({
      META_PIXEL_ID: "1",
      META_ACCESS_TOKEN: "x",
      META_API_VERSION: "v99.0",
      // Normalized by src/config.ts: case and spaces don't matter.
      META_CONTENT_ID: " SKU ",
      AWIN_ADVERTISER_ID: "1",
      AWIN_API_KEY: "x",
      AWIN_TEST: "true",
    });
    const shop = resolveShop(config, testEnv, uniqueShop())!;
    const order = fixtureOrder(shop.shop);
    const identity = { cookies: {}, clickIds: { awc: { value: "a", at: Date.now() } }, consent: { marketing: true }, collectedAt: 0 };
    order.createdAt = new Date().toISOString();
    const ctx = { shop: shop.shop, log: (await import("../src/core/log")).createLogger(), fetch: fetchMock };
    const [metaTarget, awinTarget] = shop.targets;
    expect(await metaTarget!.purchase(order, identity, ctx)).toBeUndefined();
    expect(await awinTarget!.purchase(order, identity, ctx)).toEqual({ recorded: false });
    expect(seen[0]!.url).toBe("https://graph.facebook.com/v99.0/1/events");
    expect(seen[0]!.body.data[0].custom_data.content_ids).toEqual(["TOTE-NAT", "44100000001002"]);
    expect(seen[1]!.body.orders[0].isTest).toBe(true);
  });

  it("leaves Awin test mode off unless AWIN_TEST is exactly true", async () => {
    const { env: testEnv } = makeEnv({ AWIN_ADVERTISER_ID: "1", AWIN_API_KEY: "x", AWIN_TEST: "yes" });
    const shop = resolveShop(config, testEnv, uniqueShop())!;
    const seen: any[] = [];
    const fetchMock = (async (_: RequestInfo | URL, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const identity = { cookies: {}, clickIds: { awc: { value: "a", at: Date.now() } }, consent: {}, collectedAt: 0 };
    const ctx = { shop: shop.shop, log: (await import("../src/core/log")).createLogger(), fetch: fetchMock };
    expect(await shop.targets[0]!.purchase(fixtureOrder(shop.shop), identity, ctx)).toBeUndefined();
    expect("isTest" in seen[0].orders[0]).toBe(false);
  });

  it("wires AWIN_COOKIE_DAYS", async () => {
    const seen: any[] = [];
    const fetchMock = (async (_: RequestInfo | URL, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const identity = { cookies: {}, clickIds: { awc: { value: "a", at: Date.now() - 40 * 24 * 3600 * 1000 } }, consent: {}, collectedAt: 0 };
    const ctx = { shop: "s.myshopify.com", log: (await import("../src/core/log")).createLogger(), fetch: fetchMock };
    for (const [days, sends] of [["60", 1], [undefined, 0]] as const) {
      const { env: testEnv } = makeEnv({ AWIN_ADVERTISER_ID: "1", AWIN_API_KEY: "x", AWIN_COOKIE_DAYS: days });
      const shop = resolveShop(config, testEnv, uniqueShop())!;
      seen.length = 0;
      await shop.targets[0]!.purchase(fixtureOrder(shop.shop), identity, ctx);
      expect(seen).toHaveLength(sends);
    }
  });
});
