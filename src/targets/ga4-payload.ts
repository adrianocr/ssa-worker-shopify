import { money } from "../core/money";
import type { Identity, Order, OrderLine, Refund, RefundLine } from "../core/types";

export interface Ga4Item {
  item_id?: string;
  item_name?: string;
  item_brand?: string;
  item_variant?: string;
  price?: number;
  quantity: number;
  discount?: number;
}

export type ConsentStatus = "GRANTED" | "DENIED";

export interface Ga4Payload {
  client_id: string;
  timestamp_micros?: number;
  consent?: { ad_user_data: ConsentStatus; ad_personalization: ConsentStatus };
  events: { name: "purchase" | "refund"; params: Record<string, unknown> }[];
}

/** The Measurement Protocol only backdates events by up to 72 hours. */
export const MAX_BACKDATE_MS = 72 * 60 * 60 * 1000;

/** `_ga` is `GA1.1.<a>.<b>`; the client_id is the last two segments. */
export function parseClientId(cookie: string | undefined): string | undefined {
  if (!cookie) return undefined;
  const parts = cookie.split(".");
  return parts.length >= 4 ? parts.slice(-2).join(".") : undefined;
}

/** `_ga_<stream>` is `GS1.1.<sid>....` or `GS2.1.s<sid>$o1$...`. */
export function parseSessionId(cookie: string | undefined): string | undefined {
  if (!cookie) return undefined;
  return cookie.match(/^GS\d\.\d\.s?(\d+)/)?.[1];
}

export function sessionCookieName(measurementId: string): string {
  return `_ga_${measurementId.replace(/^G-/, "")}`;
}

// Google's Measurement Protocol reference: "If a discount applies to the item, set price to the
// discounted unit price and specify the unit price discount in the discount parameter." Shopify
// gives the unit price before discount and the discount for the whole line, so both are per unit here.
function lineItem(line: OrderLine): Ga4Item {
  const perUnit = line.discount > 0 && line.quantity > 0 ? money(line.discount / line.quantity) : 0;
  const item: Ga4Item = {
    item_id: line.sku || line.variantId || line.id,
    item_name: line.title,
    price: money(line.price - perUnit),
    quantity: line.quantity,
  };
  if (line.vendor) item.item_brand = line.vendor;
  if (line.variantTitle) item.item_variant = line.variantTitle;
  if (perUnit > 0) item.discount = perUnit;
  return item;
}

function refundItem(line: RefundLine): Ga4Item {
  const item: Ga4Item = { quantity: line.quantity };
  const id = line.sku || line.variantId;
  if (id) item.item_id = id;
  if (line.title) item.item_name = line.title;
  if (line.quantity > 0) item.price = money(line.amount / line.quantity);
  return item;
}

/** Clock skew allowed between Shopify and the worker before a future time is dropped. */
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * Event time for GA4, or undefined when it's unparseable, more than MAX_FUTURE_SKEW_MS in the
 * future, or past the 72 hour limit. A time slightly in the future is clamped to now.
 */
function timestampMicros(iso: string, now: number): number | undefined {
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t - now > MAX_FUTURE_SKEW_MS || now - t > MAX_BACKDATE_MS) return undefined;
  return Math.min(t, now) * 1000;
}

/**
 * Google's consent signals from the visitor's marketing choice. Unknown consent sends nothing, so
 * the property's own default applies.
 */
function consentFor(identity: Identity | null): Ga4Payload["consent"] {
  const marketing = identity?.consent.marketing;
  if (marketing === undefined) return undefined;
  const status: ConsentStatus = marketing ? "GRANTED" : "DENIED";
  return { ad_user_data: status, ad_personalization: status };
}

function payload(clientId: string, identity: Identity | null, time: number | undefined, event: Ga4Payload["events"][number]): Ga4Payload {
  const out: Ga4Payload = { client_id: clientId, events: [event] };
  if (time !== undefined) out.timestamp_micros = time;
  const consent = consentFor(identity);
  if (consent) out.consent = consent;
  return out;
}

/** Without a `_ga` cookie the order id keeps the event from being dropped; it attributes as a new user. */
function clientIdFor(identity: Identity | null, fallback: string): string {
  return parseClientId(identity?.cookies._ga) || fallback;
}

export function buildPurchase(order: Order, identity: Identity | null, measurementId?: string, now = Date.now()): Ga4Payload {
  const params: Record<string, unknown> = {
    currency: order.currency,
    // GA4's value excludes tax and shipping, which have their own parameters.
    value: money(Math.max(0, order.total - order.tax - order.shipping)),
    transaction_id: order.id,
    tax: order.tax,
    shipping: order.shipping,
    items: order.lines.map(lineItem),
    engagement_time_msec: 100,
  };
  const sessionId = measurementId ? parseSessionId(identity?.cookies[sessionCookieName(measurementId)]) : undefined;
  if (sessionId) params.session_id = sessionId;
  return payload(clientIdFor(identity, order.id), identity, timestampMicros(order.createdAt, now), { name: "purchase", params });
}

/**
 * The refund's value is pre-tax like the purchase's: the refunded line subtotals in shop currency,
 * from `linesAmount`, which counts lines the queue cut. A refund without lines (shipping only, or
 * an amount typed in by hand) uses the money returned, in the currency it was returned in.
 */
export function buildRefund(refund: Refund, identity: Identity | null, now = Date.now()): Ga4Payload {
  // Messages queued by older versions have no linesAmount; their lines are summed instead.
  const linesAmount = refund.linesAmount ?? (refund.lines.length ? money(refund.lines.reduce((sum, l) => sum + l.amount, 0)) : undefined);
  const hasLines = linesAmount !== undefined;
  const params: Record<string, unknown> = {
    currency: hasLines ? refund.currency : refund.amountCurrency || refund.currency,
    value: hasLines ? linesAmount : refund.amount,
    // Must match the purchase's transaction_id for GA4 to reverse it.
    transaction_id: refund.orderId,
  };
  if (refund.lines.length) params.items = refund.lines.map(refundItem);
  return payload(clientIdFor(identity, refund.orderId), identity, timestampMicros(refund.createdAt, now), { name: "refund", params });
}
