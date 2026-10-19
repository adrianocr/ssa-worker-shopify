import { describe, expect, it } from "vitest";
import { normalizeOrder, normalizeRefund, verifyHmac } from "../src/core/shopify";
import { orderFixture, refundFixture, sign } from "./helpers";

const shop = "example-store.myshopify.com";

describe("verifyHmac", () => {
  it("accepts the right signature and rejects others", async () => {
    const enc = new TextEncoder();
    const json = JSON.stringify({ a: 1 });
    const raw = enc.encode(json);
    expect(await verifyHmac(raw, await sign(raw, "s"), "s")).toBe(true);
    expect(await verifyHmac(raw.buffer as ArrayBuffer, await sign(raw, "s"), "s")).toBe(true);
    expect(await verifyHmac(enc.encode(json + " "), await sign(raw, "s"), "s")).toBe(false);
    expect(await verifyHmac(raw, await sign(raw, "s"), undefined)).toBe(false);
    expect(await verifyHmac(raw, "", "s")).toBe(false);
    expect(await verifyHmac(raw, "c2hvcnQ=", "s")).toBe(false);
  });
});

describe("normalizeOrder", () => {
  it("maps a realistic orders/create payload", () => {
    expect(normalizeOrder(shop, orderFixture)).toEqual({
      shop,
      id: "5820000001001",
      name: "#1001",
      checkoutToken: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
      currency: "USD",
      total: 93.37,
      subtotal: 84,
      tax: 4.38,
      shipping: 4.99,
      discount: 10,
      createdAt: "2026-10-16T14:03:21-04:00",
      lines: [
        {
          id: "14800000001001",
          productId: "8030000001001",
          variantId: "44100000001001",
          sku: "TOTE-NAT",
          title: "Canvas Tote",
          variantTitle: "Natural",
          vendor: "Example Goods",
          price: 32,
          quantity: 2,
          discount: 6.81,
        },
        {
          id: "14800000001002",
          productId: "8030000001002",
          variantId: "44100000001002",
          sku: undefined,
          title: "Enamel Mug",
          variantTitle: undefined,
          vendor: "Example Goods",
          price: 30,
          quantity: 1,
          discount: 3.19,
        },
      ],
      itemCount: 3,
      customer: {
        id: "7710000001001",
        email: "jane.doe@example.com",
        phone: "+1 (555) 010-0199",
        firstName: "Jane",
        lastName: "Doe",
        city: "Springfield",
        province: "IL",
        zip: "62701-1234",
        countryCode: "US",
      },
      browserIp: "203.0.113.24",
      userAgent: orderFixture.client_details.user_agent,
      landingSite: "/products/canvas-tote?utm_source=google&gclid=TeSt-GcLiD-123",
      test: false,
      sourceName: "web",
    });
  });

  it("carries Shopify's test flag and source_name", () => {
    expect(normalizeOrder(shop, { ...orderFixture, test: true, source_name: "pos" })).toMatchObject({ test: true, sourceName: "pos" });
    const bare = normalizeOrder(shop, { id: 1 });
    expect(bare.test).toBe(false);
    expect(bare.sourceName).toBeUndefined();
  });

  it("reads shop money, not presentment money, on an order paid in another currency", () => {
    const both = (shopAmount: string, presentment: string) => ({
      shop_money: { amount: shopAmount, currency_code: "USD" },
      presentment_money: { amount: presentment, currency_code: "EUR" },
    });
    const order = normalizeOrder(shop, {
      id: 7,
      // The plain fields here are deliberately wrong, to show the _set values win.
      currency: "EUR",
      total_price: "999",
      total_price_set: both("110.00", "100.00"),
      subtotal_price_set: both("90.00", "81.82"),
      total_tax_set: both("10.00", "9.09"),
      total_discounts_set: both("5.00", "4.55"),
      total_shipping_price_set: both("10.00", "9.09"),
      line_items: [
        {
          id: 1,
          title: "X",
          quantity: 2,
          price: "999",
          price_set: both("47.50", "43.18"),
          discount_allocations: [{ amount: "999", amount_set: both("5.00", "4.55") }],
        },
      ],
    });
    expect(order).toMatchObject({ currency: "USD", total: 110, subtotal: 90, tax: 10, discount: 5, shipping: 10 });
    expect(order.lines[0]).toMatchObject({ price: 47.5, discount: 5 });
  });

  it("parses numbers safely and falls back to shipping lines and addresses", () => {
    const order = normalizeOrder(shop, {
      id: 42,
      currency: "EUR",
      total_price: "not a number",
      total_tax: null,
      shipping_lines: [{ price: "1.10" }, { price: "2.20" }],
      shipping_address: { city: "Lyon", country_code: "FR", first_name: "Ana" },
      line_items: [{ id: 1, title: "X", price: "", quantity: "3", total_discount: "1.5" }],
    });
    expect(order.total).toBe(0);
    expect(order.tax).toBe(0);
    expect(order.shipping).toBe(3.3);
    expect(order.name).toBe("#42");
    expect(order.customer).toMatchObject({ city: "Lyon", countryCode: "FR", firstName: "Ana" });
    expect(order.customer.id).toBeUndefined();
    expect(order.lines[0]).toMatchObject({ price: 0, quantity: 3, discount: 1.5 });
  });

  it("throws on a payload with no id", () => {
    expect(() => normalizeOrder(shop, {})).toThrow();
    expect(() => normalizeOrder(shop, null)).toThrow();
  });
});

describe("normalizeRefund", () => {
  it("maps a realistic refunds/create payload", () => {
    expect(normalizeRefund(shop, refundFixture)).toEqual({
      shop,
      id: "9330000001001",
      orderId: "5820000001001",
      currency: "USD",
      amount: 26.95,
      lines: [{ sku: undefined, variantId: "44100000001002", title: "Enamel Mug", quantity: 1, amount: 26.81 }],
      linesAmount: 26.81,
      createdAt: "2026-10-18T09:12:44-04:00",
    });
  });

  it("falls back to line subtotals only when there are no transactions at all", () => {
    const refund = normalizeRefund(shop, { ...refundFixture, transactions: [] });
    expect(refund.amount).toBe(26.81);
    expect(refund.currency).toBe("USD");
    expect(refund.amountCurrency).toBeUndefined();
  });

  it("gives 0 when every transaction is pending or failed, or the successful ones total 0", () => {
    const pending = normalizeRefund(shop, {
      ...refundFixture,
      transactions: [
        { kind: "refund", status: "pending", amount: "26.95", currency: "USD" },
        { kind: "refund", status: "failure", amount: "26.95", currency: "USD" },
      ],
    });
    expect(pending.amount).toBe(0);
    const zero = normalizeRefund(shop, { ...refundFixture, transactions: [{ kind: "refund", status: "success", amount: "0.00" }] });
    expect(zero.amount).toBe(0);
  });

  it("uses shop money for lines and keeps a transaction in another currency paired with it", () => {
    const refund = normalizeRefund(shop, {
      ...refundFixture,
      transactions: [{ kind: "refund", status: "success", amount: "24.50", currency: "EUR" }],
      refund_line_items: [
        {
          quantity: 1,
          subtotal: 999,
          subtotal_set: { shop_money: { amount: "26.81", currency_code: "USD" }, presentment_money: { amount: "24.40", currency_code: "EUR" } },
          line_item: { title: "Enamel Mug", variant_id: 1 },
        },
      ],
    });
    expect(refund).toMatchObject({ currency: "USD", amount: 24.5, amountCurrency: "EUR" });
    expect(refund.lines[0]!.amount).toBe(26.81);
  });

  it("throws without an order id", () => {
    expect(() => normalizeRefund(shop, { id: 1 })).toThrow();
  });
});
