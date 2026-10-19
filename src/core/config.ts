import { log } from "./log";
import type { Target, WorkerEnv } from "./types";

/** Worker env (vars and secrets) merged with the shop's STORES entry. */
export type Vars = Record<string, string | undefined>;

export interface Config {
  webhookSecret: string | undefined;
  targets: Target[];
}

export type ConfigFn = (vars: Vars) => Config;

export function defineConfig(fn: ConfigFn): ConfigFn {
  return fn;
}

export interface ShopConfig {
  shop: string;
  webhookSecret: string | undefined;
  /** Enabled targets only. */
  targets: Target[];
  /** Targets turned off for missing config, for the warning. */
  disabled: { id: string; missing: string[] }[];
  /** SEND_TEST_ORDERS is "true": orders Shopify flags as test go out too. */
  sendTestOrders: boolean;
  /** ORDER_SOURCES as a set of source names, or null for "*" (every source). */
  orderSources: Set<string> | null;
}

export const DEFAULT_ORDER_SOURCES = "web";

/** Comma-separated source names, trimmed and lowercased. "*" anywhere means every source. */
export function parseOrderSources(raw: string | undefined): Set<string> | null {
  const names = (raw?.trim() ? raw : DEFAULT_ORDER_SOURCES)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (names.includes("*")) return null;
  return new Set(names.length ? names : [DEFAULT_ORDER_SOURCES]);
}

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function normalizeShop(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const shop = value.trim().toLowerCase();
  return shop.length <= 255 && SHOP_RE.test(shop) ? shop : null;
}

let storesCache: { raw: string; parsed: Record<string, Vars> } | null = null;

function parseStores(raw: string): Record<string, Vars> {
  if (storesCache?.raw === raw) return storesCache.parsed;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("STORES is not valid JSON");
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("STORES must be a JSON object keyed by shop domain");
  }
  const parsed: Record<string, Vars> = {};
  for (const [domain, entry] of Object.entries(json)) {
    if (!entry || typeof entry !== "object") continue;
    const vars: Vars = {};
    for (const [k, v] of Object.entries(entry)) {
      if (v !== undefined && v !== null) vars[k] = String(v);
    }
    parsed[domain.trim().toLowerCase()] = vars;
  }
  storesCache = { raw, parsed };
  return parsed;
}

function envVars(env: WorkerEnv): Vars {
  const vars: Vars = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") vars[k] = v;
  return vars;
}

function storesOf(env: WorkerEnv): Record<string, Vars> | null {
  return env.STORES?.trim() ? parseStores(env.STORES) : null;
}

// /collect asks "is this shop accepted?" on every hit, so the allowlist is built once per env
// object. The raw strings are kept with it, so a changed SHOP_DOMAINS or STORES rebuilds it.
const allowLists = new WeakMap<object, { domains: unknown; stores: unknown; allow: Set<string> | null }>();

/** SHOP_DOMAINS entries plus STORES keys, or null when neither is set (any shop is accepted). */
function allowList(env: WorkerEnv): Set<string> | null {
  const cached = allowLists.get(env);
  if (cached && cached.domains === env.SHOP_DOMAINS && cached.stores === env.STORES) return cached.allow;
  const stores = storesOf(env);
  const domains = env.SHOP_DOMAINS?.trim() ? env.SHOP_DOMAINS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : null;
  const allow = !domains && !stores ? null : new Set([...(domains ?? []), ...Object.keys(stores ?? {})]);
  allowLists.set(env, { domains: env.SHOP_DOMAINS, stores: env.STORES, allow });
  return allow;
}

/**
 * Which shops are accepted: when SHOP_DOMAINS or STORES is set, any shop named in either one.
 * When neither is set, any shop whose webhook verifies against SHOPIFY_WEBHOOK_SECRET.
 */
export function isAcceptedShop(env: WorkerEnv, shop: string): boolean {
  return allowList(env)?.has(shop) ?? true;
}

/** True when SHOP_DOMAINS or STORES names this shop, as opposed to "any shop is accepted". */
export function isListedShop(env: WorkerEnv, shop: string): boolean {
  return allowList(env)?.has(shop) ?? false;
}

/** The env merged with the shop's STORES entry, or null for a shop that isn't accepted. */
export function shopVars(env: WorkerEnv, shop: string): Vars | null {
  if (!isAcceptedShop(env, shop)) return null;
  return { ...envVars(env), ...storesOf(env)?.[shop] };
}

// Both caches are keyed by a shop name taken from an unauthenticated header, so they're capped.
// Dropping the oldest entry only costs a re-evaluation of the config function.
export const MAX_CACHED_SHOPS = 100;

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.size >= MAX_CACHED_SHOPS) map.delete(map.keys().next().value as K);
  map.set(key, value);
}

const warned = new Map<string, true>();
const resolved = new WeakMap<object, Map<string, ShopConfig | null>>();

/**
 * Logs "target disabled, missing config" once per shop and target. Call it only for a trusted
 * shop: one whose webhook passed HMAC, or one listed in SHOP_DOMAINS or STORES.
 */
export function warnDisabled(config: ShopConfig): void {
  for (const t of config.disabled) {
    const key = `${config.shop}:${t.id}`;
    if (warned.has(key)) continue;
    remember(warned, key, true);
    log.warn("target disabled, missing config", { shop: config.shop, target: t.id, missing: t.missing });
  }
}

/** Returns null for a shop that isn't accepted. Memoized per env object and shop. */
export function resolveShop(fn: ConfigFn, env: WorkerEnv, shop: string): ShopConfig | null {
  let byShop = resolved.get(env);
  if (!byShop) resolved.set(env, (byShop = new Map()));
  if (byShop.has(shop)) return byShop.get(shop) ?? null;

  const vars = shopVars(env, shop);
  let result: ShopConfig | null = null;
  if (vars) {
    const config = fn(vars);
    result = {
      shop,
      webhookSecret: config.webhookSecret,
      targets: config.targets.filter((t) => t.enabled),
      disabled: config.targets.filter((t) => !t.enabled).map((t) => ({ id: t.id, missing: t.missing })),
      sendTestOrders: vars.SEND_TEST_ORDERS?.trim() === "true",
      orderSources: parseOrderSources(vars.ORDER_SOURCES),
    };
    if (isListedShop(env, shop)) warnDisabled(result);
  }
  remember(byShop, shop, result);
  return result;
}
