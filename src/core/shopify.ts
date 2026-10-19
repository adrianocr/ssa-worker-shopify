import { money } from "./money";
import type { Customer, Order, OrderLine, Refund, RefundLine } from "./types";

const enc = new TextEncoder();

function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64.trim());
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * Checks X-Shopify-Hmac-Sha256 (base64 HMAC-SHA256 of the raw body) in constant time. Takes the
 * body as bytes: decoding to a string first can change them (a BOM, invalid UTF-8).
 */
export async function verifyHmac(raw: ArrayBuffer | Uint8Array, header: string | null | undefined, secret: string | undefined): Promise<boolean> {
  if (!header || !secret) return false;
  const given = base64ToBytes(header);
  if (!given) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, raw));
  // timingSafeEqual throws on different lengths; a SHA-256 length isn't a secret.
  if (given.byteLength !== expected.byteLength) return false;
  return crypto.subtle.timingSafeEqual(given, expected);
}

type Json = Record<string, unknown>;

function obj(v: unknown): Json {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}

function arr(v: unknown): Json[] {
  return Array.isArray(v) ? v.map(obj) : [];
}

/** Non-empty trimmed string, or undefined. Numbers become strings (Shopify ids are JSON numbers). */
function str(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? s : undefined;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function first(...values: unknown[]): string | undefined {
  for (const v of values) {
    const s = str(v);
    if (s) return s;
  }
  return undefined;
}

function setAmount(v: unknown): unknown {
  return obj(obj(v).shop_money).amount;
}

function setCurrency(v: unknown): string | undefined {
  return str(obj(obj(v).shop_money).currency_code);
}

// Every amount is read from its `*_set.shop_money` twin first, with the shop currency. On an order
// paid in another currency (Shopify Markets) the presentment amounts are in the buyer's currency,
// and mixing the two sides would send, say, a EUR refund against a USD purchase. The plain fields
// are the fallback for payloads without the `_set` objects.
function shopAmount(json: Json, field: string): number {
  const fromSet = setAmount(json[`${field}_set`]);
  return num(fromSet !== undefined ? fromSet : json[field]);
}

export class PayloadError extends Error {}

function lineDiscount(li: Json): number {
  const allocations = arr(li.discount_allocations);
  if (allocations.length) return money(allocations.reduce((sum, a) => sum + shopAmount(a, "amount"), 0));
  return shopAmount(li, "total_discount");
}

function normalizeLine(li: Json): OrderLine {
  return {
    id: str(li.id) ?? "",
    productId: str(li.product_id),
    variantId: str(li.variant_id),
    sku: str(li.sku),
    title: str(li.title) ?? str(li.name) ?? "",
    variantTitle: str(li.variant_title),
    vendor: str(li.vendor),
    price: shopAmount(li, "price"),
    quantity: num(li.quantity),
    discount: lineDiscount(li),
  };
}

function normalizeCustomer(o: Json): Customer {
  const c = obj(o.customer);
  const billing = obj(o.billing_address);
  const shipping = obj(o.shipping_address);
  const fallback = obj(c.default_address);
  const addr = (key: string) => first(billing[key], shipping[key], fallback[key]);
  return {
    id: str(c.id),
    email: first(o.email, o.contact_email, c.email),
    phone: first(o.phone, c.phone, billing.phone, shipping.phone),
    firstName: first(c.first_name, billing.first_name, shipping.first_name),
    lastName: first(c.last_name, billing.last_name, shipping.last_name),
    city: addr("city"),
    province: addr("province_code") ?? addr("province"),
    zip: addr("zip"),
    countryCode: addr("country_code"),
  };
}

/** orders/create (REST webhook JSON) to Order. Throws PayloadError when there's no order id. */
export function normalizeOrder(shop: string, payload: unknown): Order {
  const o = obj(payload);
  const id = str(o.id);
  if (!id) throw new PayloadError("order has no id");

  const shippingSet = setAmount(o.total_shipping_price_set);
  const shipping =
    shippingSet !== undefined
      ? num(shippingSet)
      : money(arr(o.shipping_lines).reduce((sum, l) => sum + shopAmount(l, "price"), 0));

  const lines = arr(o.line_items).map(normalizeLine);
  return {
    shop,
    id,
    name: str(o.name) ?? `#${str(o.order_number) ?? id}`,
    checkoutToken: str(o.checkout_token),
    currency: setCurrency(o.total_price_set) ?? str(o.currency) ?? "",
    total: shopAmount(o, "total_price"),
    subtotal: shopAmount(o, "subtotal_price"),
    tax: shopAmount(o, "total_tax"),
    shipping,
    discount: shopAmount(o, "total_discounts"),
    createdAt: str(o.created_at) ?? new Date().toISOString(),
    lines,
    itemCount: lines.reduce((n, l) => n + l.quantity, 0),
    customer: normalizeCustomer(o),
    browserIp: str(o.browser_ip),
    userAgent: str(obj(o.client_details).user_agent),
    landingSite: str(o.landing_site),
    test: o.test === true,
    sourceName: str(o.source_name),
  };
}

/**
 * refunds/create to Refund. Amount is the sum of successful refund transactions, the money
 * returned. Only a refund with no transactions at all falls back to the refunded line subtotals; a
 * refund whose transactions are all pending or failed gives 0, and the consumer skips it.
 * Currency is the shop currency and can be empty here; the consumer fills it from the stored order.
 */
export function normalizeRefund(shop: string, payload: unknown): Refund {
  const r = obj(payload);
  const id = str(r.id);
  const orderId = str(r.order_id);
  if (!id || !orderId) throw new PayloadError("refund has no id or order_id");

  const refundLines = arr(r.refund_line_items);
  const lines: RefundLine[] = refundLines.map((rli) => {
    const li = obj(rli.line_item);
    return {
      sku: str(li.sku),
      variantId: str(li.variant_id),
      title: str(li.title),
      quantity: num(rli.quantity),
      amount: shopAmount(rli, "subtotal"),
    };
  });
  const currency = first(...refundLines.map((rli) => setCurrency(rli.subtotal_set)), setCurrency(r.total_duties_set));
  // Summed here, from every line, because the queue may cut `lines` to fit a message.
  const linesAmount = money(lines.reduce((sum, l) => sum + l.amount, 0));

  // Transactions have no shop-money twin in the REST payload, so their amount is in whatever
  // currency the buyer paid in. It keeps that currency next to it instead of borrowing the shop's.
  const transactions = arr(r.transactions);
  let amount = 0;
  let amountCurrency: string | undefined;
  for (const t of transactions) {
    if (t.kind === "refund" && t.status === "success") {
      amount += shopAmount(t, "amount");
      amountCurrency ??= setCurrency(t.amount_set) ?? str(t.currency);
    }
  }
  if (!transactions.length) {
    amount = linesAmount;
    amountCurrency = undefined;
  }

  const refund: Refund = {
    shop,
    id,
    orderId,
    currency: currency ?? "",
    amount: money(amount),
    lines,
    createdAt: str(r.created_at) ?? new Date().toISOString(),
  };
  if (lines.length) refund.linesAmount = linesAmount;
  if (amountCurrency && amountCurrency !== currency) refund.amountCurrency = amountCurrency;
  return refund;
}
