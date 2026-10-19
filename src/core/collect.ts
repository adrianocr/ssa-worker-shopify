import { normalizeShop } from "./config";
import type { Consent, ConsentCategory, Identity } from "./types";

export const MAX_COLLECT_BYTES = 16 * 1024;

/**
 * Body the pixel POSTs to /collect (as text/plain to skip the CORS preflight).
 * clickIds values may be a plain string (first seen now) or { value, at }.
 */
export interface CollectPayload {
  shop: string;
  checkoutToken: string;
  /** Accepted and ignored. Older pixels send it; identity never joins on it (see queue.ts). */
  orderId?: unknown;
  clientId?: string;
  cookies?: Record<string, string>;
  clickIds?: Record<string, string | { value: string; at?: number }>;
  consent?: Consent;
  pageUrl?: string;
}

export interface CollectInput {
  shop: string;
  checkoutToken: string;
  clientId?: string;
  cookies: Record<string, string>;
  clickIds: Record<string, { value: string; at: number }>;
  consent: Consent;
  pageUrl?: string;
}

const CATEGORIES: ConsentCategory[] = ["analytics", "marketing", "preferences", "sale_of_data"];
const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_ENTRIES = 32;

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function shortString(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;
}

/** Returns null when the body doesn't have the expected shape. Unknown fields are dropped. */
export function parseCollect(body: unknown, now = Date.now()): CollectInput | null {
  if (!isObject(body)) return null;
  const shop = normalizeShop(body.shop);
  const checkoutToken = shortString(body.checkoutToken, 256);
  if (!shop || !checkoutToken) return null;

  const cookies: Record<string, string> = {};
  if (body.cookies !== undefined) {
    if (!isObject(body.cookies)) return null;
    for (const [name, value] of Object.entries(body.cookies).slice(0, MAX_ENTRIES)) {
      const v = shortString(value, 1024);
      if (NAME_RE.test(name) && v) cookies[name] = v;
    }
  }

  const clickIds: Record<string, { value: string; at: number }> = {};
  if (body.clickIds !== undefined) {
    if (!isObject(body.clickIds)) return null;
    for (const [name, raw] of Object.entries(body.clickIds).slice(0, MAX_ENTRIES)) {
      if (!NAME_RE.test(name)) continue;
      const value = shortString(isObject(raw) ? raw.value : raw, 1024);
      if (!value) continue;
      const at = isObject(raw) && typeof raw.at === "number" && Number.isFinite(raw.at) && raw.at > 0 && raw.at <= now ? raw.at : now;
      clickIds[name] = { value, at };
    }
  }

  const consent: Consent = {};
  if (body.consent !== undefined) {
    if (!isObject(body.consent)) return null;
    for (const c of CATEGORIES) {
      const v = body.consent[c];
      if (typeof v === "boolean") consent[c] = v;
    }
  }

  return {
    shop,
    checkoutToken,
    clientId: shortString(body.clientId, 256),
    cookies,
    clickIds,
    consent,
    pageUrl: shortString(body.pageUrl, 2048),
  };
}

/**
 * Newer values win, except a click id seen again with the same value keeps its first-seen time.
 */
export function mergeIdentity(
  prev: Identity | null,
  input: CollectInput,
  request: { ip?: string; userAgent?: string },
  now = Date.now(),
): Identity {
  const clickIds = { ...prev?.clickIds };
  for (const [name, next] of Object.entries(input.clickIds)) {
    const old = clickIds[name];
    clickIds[name] = old && old.value === next.value ? { value: old.value, at: Math.min(old.at, next.at) } : next;
  }
  return {
    shopifyClientId: input.clientId ?? prev?.shopifyClientId,
    cookies: { ...prev?.cookies, ...input.cookies },
    clickIds,
    consent: { ...prev?.consent, ...input.consent },
    ip: request.ip ?? prev?.ip,
    userAgent: request.userAgent ?? prev?.userAgent,
    pageUrl: input.pageUrl ?? prev?.pageUrl,
    collectedAt: now,
  };
}
