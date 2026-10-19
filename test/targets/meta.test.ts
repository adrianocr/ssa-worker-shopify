import { describe, expect, it, vi } from "vitest";
import { TargetError } from "../../src/core/target";
import type { Identity, Logger, Order, TargetContext } from "../../src/core/types";
import { hashIfPresent, normalizeCity, normalizePhone, normalizeZip, sha256Hex } from "../../src/targets/hash";
import { log } from "../../src/core/log";
import { meta, parseContentId } from "../../src/targets/meta";

const H = {
  email: "973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b",
  us: "79adb2a2fce5c6ba215fe5f27f532d4e7edbac4b6a5e09e1ef3a08084a904621",
  john: "96d9632f363564cc3032521409cf22a852f2032eec099ed5967c0d000cec607a",
  phone: "4b4fb60638907d714a7207905d24b5e09de607ff2d776623c998b47eeb31c309",
  newyork: "350c754ba4d38897693aa077ef43072a859d23f613443133fecbbd90a3512ca5",
  zip: "e443169117a184f91186b401133b20be670c7c0896f9886075e5d9b81e9d076b",
  ny: "1b06e2003f8420d6fa42badd8f77ec0f706b976b7a48b13c567dc5a559681683",
};

function makeCtx(respond: () => Response = () => new Response("{}", { status: 200 })) {
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => respond());
  const log: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => log,
  };
  const ctx: TargetContext = { shop: "s.myshopify.com", log, fetch: fetchMock as unknown as typeof fetch };
  return { ctx, fetchMock, log };
}

function makeOrder(patch: Partial<Order> = {}): Order {
  return {
    shop: "s.myshopify.com",
    id: "1001",
    name: "#1001",
    currency: "USD",
    total: 93.37,
    subtotal: 84,
    tax: 6.37,
    shipping: 3,
    discount: 0,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    lines: [
      { id: "l1", productId: "p1", variantId: "v1", sku: "TOTE-1", title: "Tote", price: 30, quantity: 2, discount: 0 },
      { id: "l2", productId: "p2", variantId: "v2", title: "Mug", price: 24, quantity: 1, discount: 0 },
    ],
    customer: {
      id: "42",
      email: "  Test@Example.com ",
      phone: "+1 (212) 555-1234",
      firstName: "John",
      lastName: "Doe",
      city: "New York",
      province: "NY",
      zip: "10001-1234",
      countryCode: "US",
    },
    browserIp: "203.0.113.24",
    userAgent: "order-agent",
    ...patch,
  };
}

function makeIdentity(patch: Partial<Identity> = {}): Identity {
  return { cookies: {}, clickIds: {}, consent: { marketing: true }, collectedAt: Date.now(), ...patch };
}

const config = { pixelId: "123456", accessToken: "tok_abc" };

function sentBody(fetchMock: ReturnType<typeof makeCtx>["fetchMock"]) {
  return JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
}

describe("hash helpers", () => {
  it("matches known SHA-256 vectors", async () => {
    expect(await sha256Hex("test@example.com")).toBe(H.email);
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("never hashes an empty string", async () => {
    expect(await hashIfPresent("")).toBeUndefined();
  });

  it("normalizes phone, city and zip", () => {
    expect(normalizePhone("+1 (212) 555-1234")).toBe("12125551234");
    expect(normalizeCity("St. John's")).toBe("stjohns");
    expect(normalizeZip("10001-1234", "US")).toBe("10001");
    expect(normalizeZip("10001 1234", "us")).toBe("10001");
    expect(normalizeZip("SW1A 1AA", "GB")).toBe("sw1a1aa");
  });
});

describe("meta target", () => {
  it("is a marketing target with no refund", () => {
    const t = meta(config);
    expect(t.id).toBe("meta");
    expect(t.consent).toBe("marketing");
    expect(t.enabled).toBe(true);
    expect(t.refund).toBeUndefined();
  });

  it("is disabled without required config", () => {
    const t = meta({ pixelId: "1" });
    expect(t.enabled).toBe(false);
    expect(t.missing).toEqual(["accessToken"]);
  });

  it("posts the event to the Graph API with the default version", async () => {
    const { ctx, fetchMock } = makeCtx();
    const order = makeOrder();
    const identity = makeIdentity({
      ip: "198.51.100.7",
      userAgent: "pixel-agent",
      pageUrl: "https://shop.example/checkout",
      cookies: { _fbp: "fb.1.111.222", _fbc: "fb.1.333.cookieclid" },
      clickIds: { fbclid: { value: "ignored", at: 1 } },
    });
    await meta(config).purchase(order, identity, ctx);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v25.0/123456/events");
    expect(init?.method).toBe("POST");

    const body = sentBody(fetchMock);
    expect(Object.keys(body).sort()).toEqual(["access_token", "data"]);
    expect(body.access_token).toBe("tok_abc");
    expect(body.data).toHaveLength(1);

    const ev = body.data[0];
    expect(ev.event_name).toBe("Purchase");
    expect(ev.event_id).toBe("1001");
    expect(ev.action_source).toBe("website");
    expect(ev.event_source_url).toBe("https://shop.example/checkout");
    expect(ev.event_time).toBe(Math.floor(Date.parse(order.createdAt) / 1000));
    expect(ev.custom_data).toEqual({
      currency: "USD",
      value: 93.37,
      order_id: "1001",
      content_type: "product",
      content_ids: ["v1", "v2"],
      contents: [
        { id: "v1", quantity: 2, item_price: 30 },
        { id: "v2", quantity: 1, item_price: 24 },
      ],
      num_items: 3,
    });
    expect(ev.user_data).toEqual({
      em: H.email,
      ph: H.phone,
      fn: H.john,
      ln: await sha256Hex("doe"),
      ct: H.newyork,
      st: H.ny,
      zp: H.zip,
      country: H.us,
      external_id: await sha256Hex("42"),
      client_ip_address: "198.51.100.7",
      client_user_agent: "pixel-agent",
      fbp: "fb.1.111.222",
      fbc: "fb.1.333.cookieclid",
    });
  });

  it("honors apiVersion and testEventCode, and asks not to record a test send", async () => {
    const { ctx, fetchMock } = makeCtx();
    const result = await meta({ ...config, apiVersion: "v22.0", testEventCode: "TEST123" }).purchase(makeOrder(), null, ctx);
    expect(fetchMock.mock.calls[0][0]).toBe("https://graph.facebook.com/v22.0/123456/events");
    expect(sentBody(fetchMock).test_event_code).toBe("TEST123");
    expect(result).toEqual({ recorded: false });
  });

  it("records a live send", async () => {
    const { ctx } = makeCtx();
    expect(await meta(config).purchase(makeOrder(), null, ctx)).toBeUndefined();
  });

  describe("parseContentId", () => {
    it("trims and lowercases a known value", () => {
      expect(parseContentId(" SKU ")).toBe("sku");
      expect(parseContentId("Product_ID")).toBe("product_id");
      expect(parseContentId(undefined)).toBeUndefined();
      expect(parseContentId("  ")).toBeUndefined();
    });

    it("falls back to variant_id and warns once per value", () => {
      const spy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
      try {
        expect(parseContentId("Handle-Once")).toBe("variant_id");
        expect(parseContentId(" handle-once")).toBe("variant_id");
        expect(parseContentId("toString")).toBe("variant_id");
        expect(spy.mock.calls.filter((c) => c[0] === "meta: unknown META_CONTENT_ID, using variant_id").map((c) => c[1])).toEqual([
          { contentId: "handle-once" },
          { contentId: "tostring" },
        ]);
      } finally {
        spy.mockRestore();
      }
    });

    it("doesn't warn per order for a bad value passed straight to the target", async () => {
      const { ctx, log: ctxLog } = makeCtx();
      await meta({ ...config, contentId: "bogus" as never }).purchase(makeOrder(), null, ctx);
      expect(ctxLog.warn).not.toHaveBeenCalled();
    });
  });

  describe("content ids", () => {
    const lines = [
      { id: "l1", productId: "p1", variantId: "v1", sku: "S1", title: "All", price: 1, quantity: 1, discount: 0 },
      { id: "l2", productId: "p2", sku: "S2", title: "No variant", price: 1, quantity: 1, discount: 0 },
      { id: "l3", productId: "p3", title: "Product only", price: 1, quantity: 1, discount: 0 },
      { id: "l4", title: "Nothing", price: 1, quantity: 1, discount: 0 },
      { id: "l5", variantId: "v5", title: "Variant only", price: 1, quantity: 1, discount: 0 },
    ];

    it.each([
      [undefined, ["v1", "S2", "p3", "l4", "v5"]],
      ["variant_id", ["v1", "S2", "p3", "l4", "v5"]],
      ["sku", ["S1", "S2", "p3", "l4", "v5"]],
      ["product_id", ["p1", "p2", "p3", "l4", "v5"]],
      ["bogus", ["v1", "S2", "p3", "l4", "v5"]],
      ["toString", ["v1", "S2", "p3", "l4", "v5"]],
    ] as const)("contentId %s", async (contentId, expected) => {
      const { ctx, fetchMock } = makeCtx();
      await meta({ ...config, contentId: contentId as never }).purchase(makeOrder({ lines }), null, ctx);
      const custom = sentBody(fetchMock).data[0].custom_data;
      expect(custom.content_ids).toEqual(expected);
      expect(custom.contents.map((c: { id: string }) => c.id)).toEqual(expected);
    });
  });

  describe("event_source_url", () => {
    it("uses the pixel's page URL first", async () => {
      const { ctx, fetchMock } = makeCtx();
      await meta(config).purchase(makeOrder({ landingSite: "/x" }), makeIdentity({ pageUrl: "https://shop.example/checkout" }), ctx);
      expect(sentBody(fetchMock).data[0].event_source_url).toBe("https://shop.example/checkout");
    });

    it("makes a landing site path absolute on the shop domain", async () => {
      const { ctx, fetchMock } = makeCtx();
      await meta(config).purchase(makeOrder({ landingSite: "/products/tote?gclid=1" }), makeIdentity(), ctx);
      expect(sentBody(fetchMock).data[0].event_source_url).toBe("https://s.myshopify.com/products/tote?gclid=1");
    });

    it("keeps an absolute landing site as it is", async () => {
      const { ctx, fetchMock } = makeCtx();
      await meta(config).purchase(makeOrder({ landingSite: "https://shop.example/landing" }), null, ctx);
      expect(sentBody(fetchMock).data[0].event_source_url).toBe("https://shop.example/landing");
    });
  });

  it("falls back to order ip, user agent and the shop URL without identity", async () => {
    const { ctx, fetchMock } = makeCtx();
    await meta(config).purchase(makeOrder(), null, ctx);
    const ud = sentBody(fetchMock).data[0].user_data;
    expect(ud.client_ip_address).toBe("203.0.113.24");
    expect(ud.client_user_agent).toBe("order-agent");
    expect(ud.fbp).toBeUndefined();
    expect(ud.fbc).toBeUndefined();
    // No pixel page URL and no landing site: the shop's home page.
    expect(sentBody(fetchMock).data[0].event_source_url).toBe("https://s.myshopify.com/");
  });

  it("builds fbc from the fbclid click id when there is no _fbc cookie", async () => {
    const { ctx, fetchMock } = makeCtx();
    const identity = makeIdentity({ clickIds: { fbclid: { value: "AbC123", at: 1760000000000 } } });
    await meta(config).purchase(makeOrder(), identity, ctx);
    expect(sentBody(fetchMock).data[0].user_data.fbc).toBe("fb.1.1760000000000.AbC123");
  });

  it("omits empty fields instead of hashing empty strings", async () => {
    const { ctx, fetchMock } = makeCtx();
    const order = makeOrder({ customer: { email: "  ", phone: "n/a", firstName: "", city: " . ", countryCode: "" } });
    delete order.browserIp;
    delete order.userAgent;
    await meta(config).purchase(order, null, ctx);
    expect(sentBody(fetchMock).data[0].user_data).toEqual({});
  });

  it("keeps non-US zips whole", async () => {
    const { ctx, fetchMock } = makeCtx();
    const order = makeOrder({ customer: { zip: "SW1A 1AA", countryCode: "GB" } });
    await meta(config).purchase(order, null, ctx);
    const ud = sentBody(fetchMock).data[0].user_data;
    expect(ud.zp).toBe(await sha256Hex("sw1a1aa"));
    expect(ud.country).toBe(await sha256Hex("gb"));
  });

  it("skips orders older than 7 days with a warning, no request and no delivery record", async () => {
    const { ctx, fetchMock, log } = makeCtx();
    const old = makeOrder({ createdAt: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString() });
    expect(await meta(config).purchase(old, null, ctx)).toEqual({ recorded: false, skipped: "order older than 7 days" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("sends orders just inside the 7 day window", async () => {
    const { ctx, fetchMock } = makeCtx();
    const recent = makeOrder({ createdAt: new Date(Date.now() - 6 * 24 * 3600 * 1000).toISOString() });
    await meta(config).purchase(recent, null, ctx);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not log PII", async () => {
    const { ctx, log } = makeCtx();
    await meta(config).purchase(makeOrder(), makeIdentity({ ip: "198.51.100.7" }), ctx);
    const logged = JSON.stringify([
      (log.info as ReturnType<typeof vi.fn>).mock.calls,
      (log.warn as ReturnType<typeof vi.fn>).mock.calls,
      (log.debug as ReturnType<typeof vi.fn>).mock.calls,
    ]);
    for (const pii of ["example.com", "198.51.100.7", "203.0.113.24", "555"]) expect(logged).not.toContain(pii);
  });

  it("throws a non-retryable TargetError on 4xx", async () => {
    const { ctx } = makeCtx(() => new Response('{"error":"bad token"}', { status: 400 }));
    const err = await meta(config).purchase(makeOrder(), null, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(TargetError);
    expect(err.retryable).toBe(false);
  });

  it.each([429, 500, 503])("throws a retryable TargetError on %i", async (status) => {
    const { ctx } = makeCtx(() => new Response("", { status }));
    const err = await meta(config).purchase(makeOrder(), null, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(TargetError);
    expect(err.retryable).toBe(true);
  });
});
