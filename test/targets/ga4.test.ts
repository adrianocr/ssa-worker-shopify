import { describe, expect, it } from "vitest";
import { TargetError } from "../../src/core/target";
import type { Identity, TargetContext } from "../../src/core/types";
import { createLogger } from "../../src/core/log";
import { ga4 } from "../../src/targets/ga4";
import { buildPurchase, buildRefund, parseClientId, parseSessionId } from "../../src/targets/ga4-payload";
import { fixtureOrder, fixtureRefund, uniqueShop } from "../helpers";

interface Seen {
  url: string;
  init: RequestInit;
  body: any;
}

function mockCtx(respond: (n: number) => Response = () => new Response(null, { status: 204 })) {
  const seen: Seen[] = [];
  const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init: init ?? {}, body: JSON.parse(String(init?.body)) });
    return respond(seen.length);
  }) as typeof fetch;
  const ctx: TargetContext = { shop: "s.myshopify.com", log: createLogger(), fetch: fetchMock };
  return { ctx, seen };
}

function identity(cookies: Record<string, string>, consent: Identity["consent"] = {}): Identity {
  return { cookies, clickIds: {}, consent, collectedAt: 0 };
}

const config = { measurementId: "G-ABC123", apiSecret: "sec ret" };

describe("ga4 cookie parsing", () => {
  it("parses _ga into a client id", () => {
    expect(parseClientId("GA1.1.123456.789012")).toBe("123456.789012");
    expect(parseClientId("GA1.2.123456.789012")).toBe("123456.789012");
    expect(parseClientId("garbage")).toBeUndefined();
    expect(parseClientId(undefined)).toBeUndefined();
  });

  it("parses both session cookie formats", () => {
    expect(parseSessionId("GS1.1.1700000000.3.1.1700000100.0.0.0")).toBe("1700000000");
    expect(parseSessionId("GS2.1.s1700000001$o2$g1$t1700000100$j0$l0$h0")).toBe("1700000001");
    expect(parseSessionId("nope")).toBeUndefined();
  });
});

describe("ga4 target", () => {
  it("is disabled without required config", () => {
    const t = ga4({ measurementId: "G-X" });
    expect(t.enabled).toBe(false);
    expect(t.missing).toEqual(["apiSecret"]);
  });

  it("sends a purchase to the live endpoint", async () => {
    const { ctx, seen } = mockCtx();
    const order = fixtureOrder(uniqueShop());
    const id = identity({ _ga: "GA1.1.111.222", _ga_ABC123: "GS1.1.1700000000.1.1.1700000001.0.0.0" });
    await ga4(config).purchase(order, id, ctx);

    expect(seen).toHaveLength(1);
    const url = new URL(seen[0]!.url);
    expect(url.origin + url.pathname).toBe("https://www.google-analytics.com/mp/collect");
    expect(url.searchParams.get("measurement_id")).toBe("G-ABC123");
    expect(url.searchParams.get("api_secret")).toBe("sec ret");
    expect(seen[0]!.init.method).toBe("POST");

    const { client_id, events } = seen[0]!.body;
    expect(client_id).toBe("111.222");
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("purchase");
    const p = events[0].params;
    expect(p.currency).toBe(order.currency);
    // 93.37 total minus 4.38 tax and 4.99 shipping.
    expect(p.value).toBe(84);
    expect(p.transaction_id).toBe(order.id);
    expect(p.tax).toBe(order.tax);
    expect(p.shipping).toBe(order.shipping);
    expect(p.engagement_time_msec).toBe(100);
    expect(p.session_id).toBe("1700000000");
    expect(p.items).toHaveLength(order.lines.length);
    const line = order.lines[0]!;
    expect(p.items[0]).toMatchObject({
      item_id: line.sku || line.variantId || line.id,
      item_name: line.title,
      quantity: line.quantity,
    });
    expect(p.items[0].price + p.items[0].discount).toBeCloseTo(line.price, 2);
  });

  it("builds item fields from the line, adding a per-unit discount only when positive", async () => {
    const { ctx, seen } = mockCtx();
    const order = fixtureOrder(uniqueShop());
    order.lines = [
      { id: "l1", variantId: "v1", sku: "SKU-1", title: "Tote", variantTitle: "Blue", vendor: "Acme", price: 20, quantity: 2, discount: 3 },
      { id: "l2", variantId: "v2", title: "Mug", price: 8, quantity: 1, discount: 0 },
      { id: "l3", title: "Sticker", price: 1, quantity: 1, discount: 0 },
    ];
    await ga4(config).purchase(order, null, ctx);
    const items = seen[0]!.body.events[0].params.items;
    expect(items[0]).toEqual({
      item_id: "SKU-1",
      item_name: "Tote",
      item_brand: "Acme",
      item_variant: "Blue",
      price: 18.5,
      quantity: 2,
      discount: 1.5,
    });
    expect(items[1]).toEqual({ item_id: "v2", item_name: "Mug", price: 8, quantity: 1 });
    expect(items[2].item_id).toBe("l3");
  });

  it("sends price as the discounted unit price and discount per unit", async () => {
    const { ctx, seen } = mockCtx();
    const order = fixtureOrder(uniqueShop());
    order.lines = [
      { id: "l1", sku: "A", title: "Three-pack", price: 15, quantity: 3, discount: 5 },
      { id: "l2", sku: "B", title: "Thirds", price: 12, quantity: 3, discount: 10 },
      { id: "l3", sku: "C", title: "Zero quantity", price: 9, quantity: 0, discount: 2 },
    ];
    await ga4(config).purchase(order, null, ctx);
    const items = seen[0]!.body.events[0].params.items;
    expect(items[0]).toMatchObject({ price: 13.33, quantity: 3, discount: 1.67 });
    expect(items[1]).toMatchObject({ price: 8.67, quantity: 3, discount: 3.33 });
    expect(items[2]).toMatchObject({ price: 9 });
    expect(items[2]).not.toHaveProperty("discount");
  });

  it("reads the GS2 session format and omits session_id when absent", async () => {
    const order = fixtureOrder(uniqueShop());
    const a = mockCtx();
    await ga4(config).purchase(order, identity({ _ga: "GA1.1.1.2", _ga_ABC123: "GS2.1.s1700000009$o1$g1" }), a.ctx);
    expect(a.seen[0]!.body.events[0].params.session_id).toBe("1700000009");

    const b = mockCtx();
    await ga4(config).purchase(order, identity({ _ga: "GA1.1.1.2" }), b.ctx);
    expect(b.seen[0]!.body.events[0].params).not.toHaveProperty("session_id");
  });

  it("falls back to the order id as client_id", async () => {
    const order = fixtureOrder(uniqueShop());
    for (const id of [null, identity({}), identity({ _ga: "bad" })]) {
      const { ctx, seen } = mockCtx();
      await ga4(config).purchase(order, id, ctx);
      expect(seen[0]!.body.client_id).toBe(order.id);
    }
  });

  it("sends a refund reusing the persisted identity", async () => {
    const { ctx, seen } = mockCtx();
    const refund = fixtureRefund(uniqueShop());
    await ga4(config).refund!(refund, identity({ _ga: "GA1.1.333.444" }), ctx);
    const { client_id, events } = seen[0]!.body;
    expect(client_id).toBe("333.444");
    expect(events[0].name).toBe("refund");
    // Pre-tax line subtotals (26.81), not the 26.95 transaction that includes tax.
    expect(events[0].params).toMatchObject({
      transaction_id: refund.orderId,
      value: 26.81,
      currency: refund.currency,
    });
    expect(events[0].params.items).toEqual([{ item_id: "44100000001002", item_name: "Enamel Mug", quantity: 1, price: 26.81 }]);
  });

  it("refund without lines sends the money returned, in its own currency, and no items", () => {
    const refund = fixtureRefund(uniqueShop(), {
      refund_line_items: [],
      transactions: [{ kind: "refund", status: "success", amount: "9.50", currency: "EUR" }],
    });
    refund.currency = "USD";
    const { params } = buildRefund(refund, null).events[0]!;
    expect(params).toMatchObject({ value: 9.5, currency: "EUR" });
    expect(params).not.toHaveProperty("items");
  });

  it("refund items split the line amount over the quantity and skip price at quantity 0", () => {
    const refund = fixtureRefund(uniqueShop());
    refund.lines = [
      { sku: "A", quantity: 3, amount: 10, title: "Three" },
      { sku: "B", quantity: 0, amount: 0 },
    ];
    const items = buildRefund(refund, null).events[0]!.params.items as { price?: number }[];
    expect(items[0]!.price).toBe(3.33);
    expect(items[1]).not.toHaveProperty("price");
  });

  describe("timestamp_micros", () => {
    const now = Date.parse("2026-10-17T12:00:00Z");
    it.each([
      ["an hour ago", "2026-10-17T11:00:00Z", Date.parse("2026-10-17T11:00:00Z") * 1000],
      ["71 hours ago", "2026-10-14T13:00:00Z", Date.parse("2026-10-14T13:00:00Z") * 1000],
      ["73 hours ago", "2026-10-14T11:00:00Z", undefined],
      ["an hour in the future", "2026-10-17T13:00:00Z", undefined],
      ["2 minutes in the future, clamped to now", "2026-10-17T12:02:00Z", Date.parse("2026-10-17T12:00:00Z") * 1000],
      ["5 minutes in the future, clamped to now", "2026-10-17T12:05:00Z", Date.parse("2026-10-17T12:00:00Z") * 1000],
      ["6 minutes in the future", "2026-10-17T12:06:00Z", undefined],
      ["unparseable", "nope", undefined],
    ])("purchase created %s", (_label, createdAt, expected) => {
      const order = fixtureOrder(uniqueShop(), { created_at: createdAt });
      expect(buildPurchase(order, null, undefined, now).timestamp_micros).toBe(expected);
    });

    it("refund uses the refund's createdAt", () => {
      const refund = fixtureRefund(uniqueShop(), { created_at: "2026-10-17T10:00:00Z" });
      expect(buildRefund(refund, null, now).timestamp_micros).toBe(Date.parse("2026-10-17T10:00:00Z") * 1000);
      expect(buildRefund({ ...refund, createdAt: "2026-10-01T10:00:00Z" }, null, now)).not.toHaveProperty("timestamp_micros");
    });
  });

  describe("consent", () => {
    it.each([
      [true, { ad_user_data: "GRANTED", ad_personalization: "GRANTED" }],
      [false, { ad_user_data: "DENIED", ad_personalization: "DENIED" }],
    ])("marketing %s", (marketing, expected) => {
      const id = identity({}, { marketing });
      expect(buildPurchase(fixtureOrder(uniqueShop()), id).consent).toEqual(expected);
      expect(buildRefund(fixtureRefund(uniqueShop()), id).consent).toEqual(expected);
    });

    it("is omitted when marketing consent is unknown", () => {
      expect(buildPurchase(fixtureOrder(uniqueShop()), null)).not.toHaveProperty("consent");
      expect(buildPurchase(fixtureOrder(uniqueShop()), identity({}, { analytics: true }))).not.toHaveProperty("consent");
    });

    it("sits at the top level of the request body", async () => {
      const { ctx, seen } = mockCtx();
      await ga4(config).purchase(fixtureOrder(uniqueShop()), identity({ _ga: "GA1.1.1.2" }, { marketing: true }), ctx);
      expect(seen[0]!.body.consent).toEqual({ ad_user_data: "GRANTED", ad_personalization: "GRANTED" });
      expect(seen[0]!.body.events[0].params).not.toHaveProperty("consent");
    });
  });

  it("refund falls back to the order id as client_id", async () => {
    const { ctx, seen } = mockCtx();
    const refund = fixtureRefund(uniqueShop());
    await ga4(config).refund!(refund, null, ctx);
    expect(seen[0]!.body.client_id).toBe(refund.orderId);
  });

  it("debug mode posts to the debug endpoint, passes on empty validation and asks not to be recorded", async () => {
    const { ctx, seen } = mockCtx(() => Response.json({ validationMessages: [] }));
    const result = await ga4({ ...config, debug: true }).purchase(fixtureOrder(uniqueShop()), null, ctx);
    expect(new URL(seen[0]!.url).pathname).toBe("/debug/mp/collect");
    expect(result).toEqual({ recorded: false });

    const refund = mockCtx(() => Response.json({ validationMessages: [] }));
    expect(await ga4({ ...config, debug: true }).refund!(fixtureRefund(uniqueShop()), null, refund.ctx)).toEqual({ recorded: false });
  });

  it("debug mode throws a non-retryable error on validation messages", async () => {
    const { ctx } = mockCtx(() =>
      Response.json({
        validationMessages: [{ fieldPath: "events[0].params.value", description: "value must be numeric", validationCode: "VALUE_INVALID" }],
      }),
    );
    const err = await ga4({ ...config, debug: true })
      .purchase(fixtureOrder(uniqueShop()), null, ctx)
      .catch((e) => e);
    expect(err).toBeInstanceOf(TargetError);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("events[0].params.value");
    expect(err.message).toContain("value must be numeric");
  });

  it("treats a live 200 with a body as success", async () => {
    const { ctx } = mockCtx(() => new Response("{}", { status: 200 }));
    await expect(ga4(config).purchase(fixtureOrder(uniqueShop()), null, ctx)).resolves.toBeUndefined();
  });

  it("throws a retryable error on 5xx and a final one on 4xx", async () => {
    const order = fixtureOrder(uniqueShop());
    const e5 = await ga4(config)
      .purchase(order, null, mockCtx(() => new Response("down", { status: 503 })).ctx)
      .catch((e) => e);
    expect(e5).toBeInstanceOf(TargetError);
    expect(e5.retryable).toBe(true);

    const e4 = await ga4(config)
      .purchase(order, null, mockCtx(() => new Response("bad", { status: 400 })).ctx)
      .catch((e) => e);
    expect(e4.retryable).toBe(false);
  });
});
