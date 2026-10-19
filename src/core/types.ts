export type ConsentCategory = "analytics" | "marketing" | "preferences" | "sale_of_data";
export type Consent = Partial<Record<ConsentCategory, boolean>>;

export interface Identity {
  shopifyClientId?: string;
  /** Raw cookie values by name. */
  cookies: Record<string, string>;
  /** at = unix ms first seen. */
  clickIds: Record<string, { value: string; at: number }>;
  consent: Consent;
  /** CF-Connecting-IP of the pixel request. */
  ip?: string;
  userAgent?: string;
  /** Checkout page URL at collect time. */
  pageUrl?: string;
  /** Unix ms. */
  collectedAt: number;
}

export interface OrderLine {
  id: string;
  productId?: string;
  variantId?: string;
  sku?: string;
  title: string;
  variantTitle?: string;
  vendor?: string;
  price: number;
  quantity: number;
  discount: number;
}

export interface Customer {
  id?: string;
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  city?: string;
  province?: string;
  zip?: string;
  countryCode?: string;
}

export interface Order {
  shop: string;
  id: string;
  name: string;
  checkoutToken?: string;
  currency: string;
  total: number;
  subtotal: number;
  tax: number;
  shipping: number;
  discount: number;
  createdAt: string;
  lines: OrderLine[];
  customer: Customer;
  browserIp?: string;
  userAgent?: string;
  landingSite?: string;
  /** Shopify's `test` flag. Optional: messages queued by older versions don't carry it. */
  test?: boolean;
  /** Shopify's `source_name` ("web", "pos", "shopify_draft_order", an app id...). */
  sourceName?: string;
  /**
   * Sum of every line's quantity, counted at normalization before `lines` can be cut. Optional:
   * messages queued by older versions don't carry it.
   */
  itemCount?: number;
  /**
   * Set when `lines` was cut to fit a queue message. Totals and `itemCount` are always complete,
   * so don't sum `lines` for a total.
   */
  linesTruncated?: boolean;
}

export interface RefundLine {
  sku?: string;
  variantId?: string;
  title?: string;
  quantity: number;
  /** Refunded subtotal for the line, before tax, in shop currency. */
  amount: number;
}

export interface Refund {
  shop: string;
  id: string;
  orderId: string;
  /** Shop currency. Can be empty here; the consumer fills it from the stored order. */
  currency: string;
  /** Money returned: the successful refund transactions. */
  amount: number;
  /**
   * Currency of `amount` when it differs from `currency`. Refund transactions carry no shop-money
   * amount, so on an order paid in another currency `amount` is in that currency.
   */
  amountCurrency?: string;
  lines: RefundLine[];
  /**
   * Sum of every line's `amount`, in shop currency, computed at normalization before `lines` can
   * be cut. Absent when the refund has no lines, and on messages queued by older versions.
   */
  linesAmount?: number;
  createdAt: string;
  /** Set when `lines` was cut to fit a queue message. `amount` and `linesAmount` are always complete. */
  linesTruncated?: boolean;
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface TargetContext {
  shop: string;
  log: Logger;
  fetch: typeof fetch;
}

/**
 * What a target may return from a send. `recorded: false` means nothing real went out: a debug
 * or test send, or an event the target skipped on purpose. The worker doesn't write a `deliveries`
 * row, so a later real send of the same event can still go out. Returning nothing records the
 * delivery.
 */
export interface DeliveryResult {
  recorded: boolean;
  /** Set when nothing was sent on purpose. The consumer logs the reason at debug level. */
  skipped?: string;
}

export interface Target {
  id: string;
  consent: ConsentCategory;
  enabled: boolean;
  missing: string[];
  purchase(order: Order, identity: Identity | null, ctx: TargetContext): Promise<void | DeliveryResult>;
  refund?(refund: Refund, identity: Identity | null, ctx: TargetContext): Promise<void | DeliveryResult>;
}

/** `targets` lists the ids still to deliver; absent means every enabled target. */
export type QueueMessage =
  | { kind: "purchase"; shop: string; order: Order; targets?: string[]; attempt: number }
  | { kind: "refund"; shop: string; refund: Refund; targets?: string[]; attempt: number };

export interface WorkerEnv {
  DB: D1Database;
  EVENTS: Queue<QueueMessage>;
  PIXEL_WAIT_SECONDS?: string;
  SHOPIFY_WEBHOOK_SECRET?: string;
  STORES?: string;
  SHOP_DOMAINS?: string;
  /** Rate limiting binding for /collect. Optional: without it there's no limit. */
  COLLECT_LIMITER?: RateLimit;
  [name: string]: unknown;
}
