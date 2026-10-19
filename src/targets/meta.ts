import { sendJson } from "../core/http";
import { log } from "../core/log";
import { defineTarget } from "../core/target";
import type { Identity, Order, OrderLine } from "../core/types";
import {
  hashIfPresent,
  normalizeCity,
  normalizeCountry,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  normalizeState,
  normalizeZip,
} from "./hash";

export interface MetaConfig {
  pixelId: string;
  accessToken: string;
  /** Sends to the Test events tab. Test sends aren't marked delivered. */
  testEventCode?: string;
  /** Graph API version, defaults to v25.0. */
  apiVersion?: string;
  /**
   * Which line field to send as content_ids and contents[].id. Defaults to variant_id, which is
   * what catalogs from Shopify's Facebook & Instagram channel use. Falls back through variant id,
   * sku, product id and line id when the preferred one is empty.
   */
  contentId?: ContentIdField;
}

export type ContentIdField = "variant_id" | "sku" | "product_id";

const DEFAULT_API_VERSION = "v25.0";
/** Meta rejects server events whose event_time is older than 7 days. */
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const CONTENT_ID_FIELDS: Record<ContentIdField, (l: OrderLine) => string | undefined> = {
  variant_id: (l) => l.variantId,
  sku: (l) => l.sku,
  product_id: (l) => l.productId,
};

const warnedContentIds = new Set<string>();

/**
 * META_CONTENT_ID to a ContentIdField: trimmed and lowercased, so " SKU " works. An unknown value
 * logs a warning once per isolate and gives variant_id. Unset gives undefined (variant_id too).
 */
export function parseContentId(raw: string | undefined): ContentIdField | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) return undefined;
  if (Object.hasOwn(CONTENT_ID_FIELDS, value)) return value as ContentIdField;
  if (!warnedContentIds.has(value)) {
    warnedContentIds.add(value);
    log.warn("meta: unknown META_CONTENT_ID, using variant_id", { contentId: value });
  }
  return "variant_id";
}

function contentId(line: OrderLine, preferred: ContentIdField): string {
  const order: ContentIdField[] = [preferred, "variant_id", "sku", "product_id"];
  for (const field of order) {
    const v = CONTENT_ID_FIELDS[field](line);
    if (v) return v;
  }
  return line.id;
}

/** Shopify's landing_site is usually a path; Meta wants an absolute URL. */
function sourceUrl(order: Order, identity: Identity | null): string {
  if (identity?.pageUrl) return identity.pageUrl;
  const landing = order.landingSite;
  if (landing && /^https?:\/\//i.test(landing)) return landing;
  if (landing?.startsWith("/")) return `https://${order.shop}${landing}`;
  return `https://${order.shop}/`;
}

async function buildUserData(order: Order, identity: Identity | null): Promise<Record<string, string>> {
  const c = order.customer;
  const hashed: Record<string, string | undefined> = {
    em: await hashIfPresent(normalizeEmail(c.email)),
    ph: await hashIfPresent(normalizePhone(c.phone)),
    fn: await hashIfPresent(normalizeName(c.firstName)),
    ln: await hashIfPresent(normalizeName(c.lastName)),
    ct: await hashIfPresent(normalizeCity(c.city)),
    st: await hashIfPresent(normalizeState(c.province)),
    zp: await hashIfPresent(normalizeZip(c.zip, c.countryCode)),
    country: await hashIfPresent(normalizeCountry(c.countryCode)),
    external_id: await hashIfPresent((c.id ?? "").trim()),
  };

  const fbclid = identity?.clickIds.fbclid;
  const plain: Record<string, string | undefined> = {
    client_ip_address: identity?.ip || order.browserIp,
    client_user_agent: identity?.userAgent || order.userAgent,
    fbp: identity?.cookies._fbp,
    fbc: identity?.cookies._fbc || (fbclid?.value ? `fb.1.${fbclid.at}.${fbclid.value}` : undefined),
  };

  const out: Record<string, string> = {};
  for (const map of [hashed, plain]) {
    for (const [k, v] of Object.entries(map)) if (v) out[k] = v;
  }
  return out;
}

export const meta = defineTarget<MetaConfig>({
  id: "meta",
  consent: "marketing",
  required: ["pixelId", "accessToken"],
  async purchase(order, identity, config, ctx) {
    const parsed = Date.parse(order.createdAt);
    const eventTimeMs = Number.isNaN(parsed) ? Date.now() : parsed;
    if (Date.now() - eventTimeMs > MAX_EVENT_AGE_MS) {
      // Nothing was sent, so don't mark the order delivered.
      ctx.log.warn("meta: order older than 7 days, skipping", { orderId: order.id, createdAt: order.createdAt });
      return { recorded: false, skipped: "order older than 7 days" };
    }

    // src/config.ts validates META_CONTENT_ID through parseContentId. This guard only covers a
    // value passed in some other way, without a warning on every order.
    const preferred: ContentIdField = config.contentId && Object.hasOwn(CONTENT_ID_FIELDS, config.contentId) ? config.contentId : "variant_id";

    const contents = order.lines.map((l) => ({
      id: contentId(l, preferred),
      quantity: l.quantity,
      item_price: l.price,
    }));

    const event = {
      event_name: "Purchase",
      event_time: Math.floor(eventTimeMs / 1000),
      event_id: order.id,
      action_source: "website",
      event_source_url: sourceUrl(order, identity),
      user_data: await buildUserData(order, identity),
      custom_data: {
        currency: order.currency,
        value: order.total,
        order_id: order.id,
        content_type: "product",
        content_ids: contents.map((c) => c.id),
        contents,
        // itemCount counts lines the queue cut; older messages have none, so sum what's here.
        num_items: order.itemCount ?? order.lines.reduce((n, l) => n + l.quantity, 0),
      },
    };

    const version = config.apiVersion || DEFAULT_API_VERSION;
    const url = `https://graph.facebook.com/${version}/${encodeURIComponent(config.pixelId)}/events`;
    await sendJson(ctx, url, {
      body: {
        data: [event],
        access_token: config.accessToken,
        ...(config.testEventCode ? { test_event_code: config.testEventCode } : {}),
      },
    });
    ctx.log.info("meta: purchase sent", { orderId: order.id, test: !!config.testEventCode });
    return config.testEventCode ? { recorded: false } : undefined;
  },
});
