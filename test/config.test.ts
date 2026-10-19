import { afterEach, describe, expect, it, vi } from "vitest";
import { defineConfig, isAcceptedShop, isListedShop, MAX_CACHED_SHOPS, parseOrderSources, resolveShop, shopVars } from "../src/core/config";
import { log } from "../src/core/log";
import { configWith, fakeTarget, makeEnv, orderFixture, uniqueShop, webhook } from "./helpers";

function disabledWarnings(spy: { mock: { calls: unknown[][] } }, shop: string) {
  return spy.mock.calls.filter((c) => c[0] === "target disabled, missing config" && (c[1] as { shop?: string })?.shop === shop);
}

describe("shop resolution", () => {
  it("accepts any shop when neither STORES nor SHOP_DOMAINS is set", () => {
    const { env } = makeEnv({ GA4_MEASUREMENT_ID: "G-TEST" });
    expect(shopVars(env, uniqueShop())).toMatchObject({ GA4_MEASUREMENT_ID: "G-TEST" });
  });

  it("merges the STORES entry over env and only accepts listed shops", () => {
    const shop = uniqueShop();
    const { env } = makeEnv({
      GA4_MEASUREMENT_ID: "G-BASE",
      GA4_API_SECRET: "base-secret",
      STORES: JSON.stringify({ [shop]: { GA4_MEASUREMENT_ID: "G-SHOP", SHOPIFY_WEBHOOK_SECRET: "shop-secret" } }),
    });
    expect(shopVars(env, shop)).toMatchObject({
      GA4_MEASUREMENT_ID: "G-SHOP",
      GA4_API_SECRET: "base-secret",
      SHOPIFY_WEBHOOK_SECRET: "shop-secret",
    });
    expect(shopVars(env, uniqueShop())).toBeNull();
  });

  it("lets SHOP_DOMAINS allow shops without a STORES entry", () => {
    const listed = uniqueShop();
    const extra = uniqueShop();
    const { env } = makeEnv({ STORES: JSON.stringify({ [listed]: {} }), SHOP_DOMAINS: `${listed},${extra.toUpperCase()}` });
    expect(shopVars(env, extra)).not.toBeNull();
    expect(shopVars(env, uniqueShop())).toBeNull();
  });

  it("accepts the union of SHOP_DOMAINS and STORES keys", () => {
    const inBoth = uniqueShop();
    const storesOnly = uniqueShop();
    const domainsOnly = uniqueShop();
    const { env } = makeEnv({
      STORES: JSON.stringify({ [inBoth]: {}, [storesOnly]: { GA4_MEASUREMENT_ID: "G-SHOP" } }),
      SHOP_DOMAINS: `${inBoth},${domainsOnly}`,
    });
    expect(shopVars(env, inBoth)).not.toBeNull();
    expect(shopVars(env, storesOnly)).toMatchObject({ GA4_MEASUREMENT_ID: "G-SHOP" });
    expect(shopVars(env, domainsOnly)).not.toBeNull();
    expect(isListedShop(env, storesOnly)).toBe(true);
    expect(shopVars(env, uniqueShop())).toBeNull();
  });

  it("rebuilds the memoized allowlist when SHOP_DOMAINS changes on the same env", () => {
    const a = uniqueShop();
    const b = uniqueShop();
    const { env } = makeEnv({ SHOP_DOMAINS: a });
    expect(isAcceptedShop(env, a)).toBe(true);
    expect(isAcceptedShop(env, b)).toBe(false);
    env.SHOP_DOMAINS = b;
    expect(isAcceptedShop(env, a)).toBe(false);
    expect(isAcceptedShop(env, b)).toBe(true);
    expect(isListedShop(env, b)).toBe(true);
  });

  it("parses ORDER_SOURCES with web as the default and * for every source", () => {
    expect(parseOrderSources(undefined)).toEqual(new Set(["web"]));
    expect(parseOrderSources("  ")).toEqual(new Set(["web"]));
    expect(parseOrderSources(" Web , pos,,")).toEqual(new Set(["web", "pos"]));
    expect(parseOrderSources("*")).toBeNull();
    expect(parseOrderSources("web,*")).toBeNull();
  });

  it("reads SEND_TEST_ORDERS and ORDER_SOURCES per store from STORES", () => {
    const shop = uniqueShop();
    const other = uniqueShop();
    const { env } = makeEnv({
      SHOP_DOMAINS: other,
      STORES: JSON.stringify({ [shop]: { SEND_TEST_ORDERS: "true", ORDER_SOURCES: "*" } }),
    });
    const fn = configWith([]);
    expect(resolveShop(fn, env, shop)).toMatchObject({ sendTestOrders: true, orderSources: null });
    expect(resolveShop(fn, env, other)).toMatchObject({ sendTestOrders: false, orderSources: new Set(["web"]) });
  });

  it("throws on invalid STORES JSON", () => {
    const { env } = makeEnv({ STORES: "{nope" });
    expect(() => shopVars(env, uniqueShop())).toThrow(/STORES/);
  });

  it("evaluates config once per env and shop and keeps only enabled targets", () => {
    let runs = 0;
    const disabled = { ...fakeTarget("off"), enabled: false, missing: ["apiKey"] };
    const fn = defineConfig((vars) => {
      runs += 1;
      return { webhookSecret: vars.SHOPIFY_WEBHOOK_SECRET, targets: [fakeTarget("on"), disabled] };
    });
    const { env } = makeEnv();
    const shop = uniqueShop();
    const a = resolveShop(fn, env, shop)!;
    const b = resolveShop(fn, env, shop)!;
    expect(a).toBe(b);
    expect(runs).toBe(1);
    expect(a.targets.map((t) => t.id)).toEqual(["on"]);
  });

  describe("caches and warnings", () => {
    afterEach(() => vi.restoreAllMocks());

    it(`keeps at most ${MAX_CACHED_SHOPS} shops per env and evicts the oldest`, () => {
      let runs = 0;
      const fn = defineConfig(() => {
        runs += 1;
        return { webhookSecret: "s", targets: [] };
      });
      const { env } = makeEnv();
      const first = uniqueShop();
      resolveShop(fn, env, first);
      for (let i = 0; i < MAX_CACHED_SHOPS; i++) resolveShop(fn, env, uniqueShop());
      expect(runs).toBe(MAX_CACHED_SHOPS + 1);
      resolveShop(fn, env, first);
      expect(runs).toBe(MAX_CACHED_SHOPS + 2);
    });

    it("doesn't warn about disabled targets for a shop that only sent a header", async () => {
      const spy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
      const disabled = { ...fakeTarget("off"), enabled: false, missing: ["apiKey"] };
      const config = configWith([disabled]);
      const { env } = makeEnv();
      const shop = uniqueShop();
      const res = await webhook(config, env, { shop, topic: "orders/create", body: orderFixture, hmac: "AAAA" });
      expect(res.status).toBe(401);
      expect(disabledWarnings(spy, shop)).toHaveLength(0);
    });

    it("warns once after a webhook passes HMAC", async () => {
      const spy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
      const disabled = { ...fakeTarget("off"), enabled: false, missing: ["apiKey"] };
      const config = configWith([disabled]);
      const { env } = makeEnv();
      const shop = uniqueShop();
      await webhook(config, env, { shop, topic: "orders/create", body: orderFixture });
      await webhook(config, env, { shop, topic: "orders/create", body: orderFixture });
      expect(disabledWarnings(spy, shop)).toHaveLength(1);
    });

    it("warns at resolve time for a shop listed in SHOP_DOMAINS", () => {
      const spy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
      const disabled = { ...fakeTarget("off"), enabled: false, missing: ["apiKey"] };
      const shop = uniqueShop();
      const { env } = makeEnv({ SHOP_DOMAINS: shop });
      resolveShop(configWith([disabled]), env, shop);
      expect(disabledWarnings(spy, shop)).toHaveLength(1);
    });
  });
});
