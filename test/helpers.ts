import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { defineConfig, type ConfigFn } from "../src/core/config";
import { normalizeOrder, normalizeRefund } from "../src/core/shopify";
import { TargetError } from "../src/core/target";
import type { ConsentCategory, DeliveryResult, Identity, Order, QueueMessage, Refund, Target, WorkerEnv } from "../src/core/types";
import { createWorker } from "../src/core/worker";
import orderFixture from "./fixtures/orders-create.json";
import refundFixture from "./fixtures/refunds-create.json";

export const SECRET = "test-webhook-secret";

let counter = 0;
/** Fresh shop per test: D1 state persists across tests in the same run. */
export function uniqueShop(): string {
  counter += 1;
  return `test-${Date.now().toString(36)}-${counter}.myshopify.com`;
}

export interface SentMessage {
  body: QueueMessage;
  delaySeconds?: number;
}

/** Records what the worker enqueues instead of delivering it. */
export function recordingQueue(fail = false) {
  const sent: SentMessage[] = [];
  const queue = {
    async send(body: QueueMessage, options?: QueueSendOptions) {
      if (fail) throw new Error("queue down");
      sent.push({ body: structuredClone(body), delaySeconds: options?.delaySeconds });
    },
    async sendBatch() {
      throw new Error("not used");
    },
  };
  return { queue: queue as unknown as Queue<QueueMessage>, sent };
}

export function makeEnv(overrides: Record<string, unknown> = {}) {
  const { queue, sent } = recordingQueue(overrides.failQueue === true);
  const testEnv: WorkerEnv = {
    DB: env.DB,
    EVENTS: queue,
    PIXEL_WAIT_SECONDS: "120",
    SHOPIFY_WEBHOOK_SECRET: SECRET,
    ...overrides,
  };
  return { env: testEnv, sent };
}

export interface Call {
  kind: "purchase" | "refund";
  ref: string;
  identity: Identity | null;
}

export interface FakeTarget extends Target {
  calls: Call[];
}

/** `fail` makes every call throw a TargetError with that retryability. `result` is what each call returns. */
export function fakeTarget(
  id: string,
  consent: ConsentCategory = "analytics",
  fail?: { retryable: boolean },
  result?: DeliveryResult,
): FakeTarget {
  const calls: Call[] = [];
  return {
    id,
    consent,
    enabled: true,
    missing: [],
    calls,
    async purchase(order: Order, identity: Identity | null) {
      calls.push({ kind: "purchase", ref: order.id, identity });
      if (fail) throw new TargetError("boom", fail.retryable);
      return result;
    },
    async refund(refund: Refund, identity: Identity | null) {
      calls.push({ kind: "refund", ref: refund.id, identity });
      if (fail) throw new TargetError("boom", fail.retryable);
      return result;
    },
  };
}

export function configWith(targets: Target[]): ConfigFn {
  return defineConfig((vars) => ({ webhookSecret: vars.SHOPIFY_WEBHOOK_SECRET, targets }));
}

export async function sign(body: string | Uint8Array, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes));
  return btoa(String.fromCharCode(...sig));
}

export async function call(configFn: ConfigFn, testEnv: WorkerEnv, request: Request): Promise<Response> {
  const worker = createWorker(configFn);
  const ctx = createExecutionContext();
  const res = await worker.fetch!(request as Request<unknown, IncomingRequestCfProperties>, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export async function webhook(
  configFn: ConfigFn,
  testEnv: WorkerEnv,
  opts: { shop: string; topic: string; body: unknown; hmac?: string | null },
): Promise<Response> {
  // A Uint8Array body is sent and signed as-is, for byte-level HMAC tests.
  const raw = opts.body instanceof Uint8Array ? opts.body : JSON.stringify(opts.body);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Shopify-Topic": opts.topic,
    "X-Shopify-Shop-Domain": opts.shop,
  };
  const hmac = opts.hmac === undefined ? await sign(raw) : opts.hmac;
  if (hmac !== null) headers["X-Shopify-Hmac-Sha256"] = hmac;
  return call(configFn, testEnv, new Request("https://worker.test/webhooks/shopify", { method: "POST", headers, body: raw }));
}

export async function collect(
  configFn: ConfigFn,
  testEnv: WorkerEnv,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return call(
    configFn,
    testEnv,
    new Request("https://worker.test/collect", {
      method: "POST",
      headers: { "Content-Type": "text/plain", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

/** Runs the queue handler over messages and returns how many were acked and which were retried. */
export async function runQueue(
  configFn: ConfigFn,
  testEnv: WorkerEnv,
  bodies: QueueMessage[],
): Promise<{ acked: number; retried: { id: string; delaySeconds?: number }[] }> {
  let acked = 0;
  const retried: { id: string; delaySeconds?: number }[] = [];
  const batch = {
    queue: "ssa-events",
    messages: bodies.map((body, i) => ({
      id: `m${i}`,
      timestamp: new Date(),
      attempts: 1,
      body: structuredClone(body),
      ack: () => void (acked += 1),
      retry: (options?: { delaySeconds?: number }) => void retried.push({ id: `m${i}`, delaySeconds: options?.delaySeconds }),
    })),
    ackAll: () => undefined,
    retryAll: () => undefined,
  } as unknown as MessageBatch<QueueMessage>;
  await createWorker(configFn).queue!(batch, testEnv, createExecutionContext());
  return { acked, retried };
}

export function fixtureOrder(shop: string, patch: Record<string, unknown> = {}): Order {
  return normalizeOrder(shop, { ...orderFixture, ...patch });
}

export function fixtureRefund(shop: string, patch: Record<string, unknown> = {}): Refund {
  return normalizeRefund(shop, { ...refundFixture, ...patch });
}

export function purchaseMessage(order: Order, extra: Partial<QueueMessage> = {}): QueueMessage {
  return { kind: "purchase", shop: order.shop, order, attempt: 1, ...extra } as QueueMessage;
}

export function refundMessage(refund: Refund, extra: Partial<QueueMessage> = {}): QueueMessage {
  return { kind: "refund", shop: refund.shop, refund, attempt: 1, ...extra } as QueueMessage;
}

/** Deliveries marked done. Pending claims are left out; see claimRows. */
export async function deliveries(shop: string): Promise<{ kind: string; ref_id: string; target: string }[]> {
  const { results } = await env.DB.prepare("SELECT kind, ref_id, target FROM deliveries WHERE shop = ? AND state = 'done' ORDER BY target")
    .bind(shop)
    .all<{ kind: string; ref_id: string; target: string }>();
  return results;
}

/** Every deliveries row for the shop, done or pending. */
export async function claimRows(shop: string): Promise<{ target: string; state: string; claimed_at: number | null }[]> {
  const { results } = await env.DB.prepare("SELECT target, state, claimed_at FROM deliveries WHERE shop = ? ORDER BY target")
    .bind(shop)
    .all<{ target: string; state: string; claimed_at: number | null }>();
  return results;
}

/**
 * Wraps the real D1 binding so a deliveries statement containing `sql` throws when it's bound for
 * `target`. Everything else goes to the real database. The default matches the claim insert.
 */
export function failingDeliveriesDb(target: string, sql = "INTO deliveries"): D1Database {
  const real = env.DB;
  return new Proxy(real, {
    get(obj, prop) {
      if (prop === "prepare") {
        return (text: string) => {
          const stmt = obj.prepare(text);
          if (!text.includes(sql)) return stmt;
          return {
            bind: (...args: unknown[]) => {
              const bound = stmt.bind(...args);
              if (!args.includes(target)) return bound;
              return { run: async () => Promise.reject(new Error("D1 write failed")) };
            },
          };
        };
      }
      const value = Reflect.get(obj, prop, obj);
      return typeof value === "function" ? value.bind(obj) : value;
    },
  });
}

/** A rate limiter double that records keys and answers with `success`. */
export function fakeLimiter(success: boolean | (() => never)) {
  const keys: string[] = [];
  const limiter = {
    async limit({ key }: { key: string }) {
      keys.push(key);
      if (typeof success === "function") success();
      return { success: success === true };
    },
  };
  return { limiter: limiter as unknown as RateLimit, keys };
}

export { orderFixture, refundFixture };
