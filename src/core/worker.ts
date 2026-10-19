import { Hono } from "hono";
import { cors } from "hono/cors";
import { readBodyCapped } from "./body";
import { MAX_COLLECT_BYTES, mergeIdentity, parseCollect } from "./collect";
import { isAcceptedShop, normalizeShop, resolveShop, warnDisabled, type ConfigFn } from "./config";
import { log } from "./log";
import { consume, enqueue, pixelWaitSeconds } from "./queue";
import { normalizeOrder, normalizeRefund, PayloadError, verifyHmac } from "./shopify";
import { openStore } from "./store";
import type { QueueMessage, WorkerEnv } from "./types";

/** Far above any Shopify order or refund payload. */
export const MAX_WEBHOOK_BYTES = 1024 * 1024;

function readBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Per-IP limit on /collect so a flood can't burn D1's daily write quota. Skipped when the binding
 * isn't configured or the request has no IP. Fails open: a limiter error never blocks the pixel.
 */
async function withinRateLimit(env: WorkerEnv, ip: string | undefined): Promise<boolean> {
  if (!env.COLLECT_LIMITER || !ip) return true;
  try {
    return (await env.COLLECT_LIMITER.limit({ key: ip })).success;
  } catch (e) {
    log.warn("rate limiter failed, allowing request", { error: e });
    return true;
  }
}

export function createApp(configFn: ConfigFn) {
  const app = new Hono<{ Bindings: WorkerEnv }>();

  app.get("/", (c) => c.text("ssa-worker-shopify: send Shopify webhooks to /webhooks/shopify"));

  app.post("/webhooks/shopify", async (c) => {
    // HMAC is over the exact bytes Shopify sent, so verify the raw buffer and only decode afterwards.
    // The cap comes first, so an oversized body is never buffered, whatever the shop or signature.
    const raw = await readBodyCapped(c.req.raw, MAX_WEBHOOK_BYTES);
    if (!raw) return c.text("body too large", 413);
    const topic = c.req.header("X-Shopify-Topic") ?? "";
    const shop = normalizeShop(c.req.header("X-Shopify-Shop-Domain"));
    const wlog = log.child({ shop, topic });

    const config = shop ? resolveShop(configFn, c.env, shop) : null;
    if (!shop || !config) {
      wlog.warn("webhook rejected, unknown shop");
      return c.text("unknown shop", 401);
    }
    if (!(await verifyHmac(raw, c.req.header("X-Shopify-Hmac-Sha256"), config.webhookSecret))) {
      wlog.warn("webhook rejected, bad hmac");
      return c.text("unauthorized", 401);
    }
    warnDisabled(config);
    if (topic !== "orders/create" && topic !== "refunds/create") {
      wlog.info("webhook ignored");
      return c.text("ignored", 200);
    }

    let message: QueueMessage;
    try {
      const body = readBody(new TextDecoder().decode(raw));
      message =
        topic === "orders/create"
          ? { kind: "purchase", shop, order: normalizeOrder(shop, body), attempt: 1 }
          : { kind: "refund", shop, refund: normalizeRefund(shop, body), attempt: 1 };
    } catch (e) {
      if (!(e instanceof PayloadError)) throw e;
      wlog.warn("webhook rejected, bad payload", { error: e });
      return c.text("bad payload", 400);
    }

    try {
      await enqueue(c.env, message, pixelWaitSeconds(c.env));
    } catch (e) {
      // 500 makes Shopify retry the webhook.
      wlog.error("enqueue failed", { error: e });
      return c.text("enqueue failed", 500);
    }
    wlog.info("webhook enqueued", { ref: message.kind === "purchase" ? message.order.id : message.refund.id });
    return c.text("ok", 200);
  });

  app.use("/collect", cors({ origin: "*", allowMethods: ["POST", "OPTIONS"], allowHeaders: ["Content-Type"], maxAge: 86400 }));

  app.post("/collect", async (c) => {
    // Inside the route, not middleware, so CORS preflights don't count against the limit.
    if (!(await withinRateLimit(c.env, c.req.header("CF-Connecting-IP")))) return c.text("too many requests", 429);

    const bytes = await readBodyCapped(c.req.raw, MAX_COLLECT_BYTES);
    if (!bytes) return c.text("body too large", 413);

    const input = parseCollect(readBody(new TextDecoder().decode(bytes)));
    if (!input) return c.text("bad request", 400);
    if (!isAcceptedShop(c.env, input.shop)) return c.text("unknown shop", 400);

    const store = await openStore(c.env.DB);
    const prev = await store.getIdentity(input.shop, input.checkoutToken);
    const identity = mergeIdentity(prev?.identity ?? null, input, {
      ip: c.req.header("CF-Connecting-IP"),
      userAgent: c.req.header("User-Agent"),
    });
    await store.putIdentity(input.shop, input.checkoutToken, identity);
    return c.body(null, 204);
  });

  return app;
}

export function createWorker(configFn: ConfigFn): ExportedHandler<WorkerEnv, QueueMessage> {
  const app = createApp(configFn);
  return {
    fetch: (request, env, ctx) => app.fetch(request, env, ctx),
    queue: (batch, env) => consume(configFn, batch, env),
    scheduled: async (_controller, env) => {
      const store = await openStore(env.DB);
      await store.cleanup();
      log.info("cleanup done");
    },
  };
}
