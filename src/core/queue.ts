import { allowed } from "./consent";
import { resolveShop, warnDisabled, type ConfigFn, type ShopConfig } from "./config";
import { log as rootLog, safeLogger } from "./log";
import { openStore, STALE_CLAIM_MS, type DeliveryKind, type Store } from "./store";
import { TargetError } from "./target";
import type { DeliveryResult, Identity, Logger, QueueMessage, Target, TargetContext, WorkerEnv } from "./types";

export const MAX_ATTEMPTS = 8;
// Cloudflare Queues caps delaySeconds at 12 hours.
const MAX_DELAY_SECONDS = 43_200;
const DEFAULT_PIXEL_WAIT_SECONDS = 120;
/** A refund that arrives before its purchase waits this long, until attempt REFUND_WAIT_ATTEMPTS. */
export const REFUND_WAIT_SECONDS = 300;
export const REFUND_WAIT_ATTEMPTS = 3;
/** Queues rejects messages over 128 KB. This leaves room for the queue's own overhead. */
export const MAX_MESSAGE_BYTES = 100 * 1024;
/**
 * A target held by another consumer's fresh claim comes back after this long: past STALE_CLAIM_MS,
 * so if that claim is still pending by then it can be taken over.
 */
export const CLAIM_WAIT_SECONDS = STALE_CLAIM_MS / 1000 + 60;

export function pixelWaitSeconds(env: WorkerEnv): number {
  const raw = env.PIXEL_WAIT_SECONDS?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), MAX_DELAY_SECONDS) : DEFAULT_PIXEL_WAIT_SECONDS;
}

/** Delay before attempt `next`: 60s, 120s, 240s ... */
export function retryDelaySeconds(next: number): number {
  return Math.min(60 * 2 ** Math.max(0, next - 2), MAX_DELAY_SECONDS);
}

/**
 * Every log call here goes through this wrapper, so a logger that throws (a broken sink, a mock)
 * can't turn a handled message into a failed one and re-enqueue or retry it a second time.
 */
const log = safeLogger(rootLog);

const enc = new TextEncoder();

function byteSize(message: QueueMessage): number {
  return enc.encode(JSON.stringify(message)).byteLength;
}

function withLines(message: QueueMessage, count: number): QueueMessage {
  if (message.kind === "purchase") {
    return { ...message, order: { ...message.order, lines: message.order.lines.slice(0, count), linesTruncated: true } };
  }
  return { ...message, refund: { ...message.refund, lines: message.refund.lines.slice(0, count), linesTruncated: true } };
}

/**
 * Cuts `lines` until the message fits in MAX_MESSAGE_BYTES. Totals stay as they are, and so do
 * Order.itemCount and Refund.linesAmount, which were computed from every line at normalization, so
 * revenue, refund value and item counts are still right; only the item list is short. Exported for tests.
 */
export function fitMessage(message: QueueMessage): QueueMessage {
  const bytes = byteSize(message);
  if (bytes <= MAX_MESSAGE_BYTES) return message;
  const lines = message.kind === "purchase" ? message.order.lines : message.refund.lines;
  // Largest line count that fits, by binary search.
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteSize(withLines(message, mid)) <= MAX_MESSAGE_BYTES) lo = mid;
    else hi = mid - 1;
  }
  log.warn("queue message too large, lines truncated", {
    shop: message.shop,
    kind: message.kind,
    ref: refId(message),
    bytes,
    lines: lines.length,
    kept: lo,
  });
  return withLines(message, lo);
}

export async function enqueue(env: WorkerEnv, message: QueueMessage, delaySeconds: number): Promise<void> {
  await env.EVENTS.send(fitMessage(message), { delaySeconds, contentType: "json" });
}

function refId(message: QueueMessage): string {
  return message.kind === "purchase" ? message.order.id : message.refund.id;
}

/** Why the shop's settings say not to send this order to any target, or null to send it. */
function orderSkip(shop: ShopConfig, test: boolean | null | undefined, source: string | null | undefined): string | null {
  if (test && !shop.sendTestOrders) return "test order";
  // An order without a source (queued by an older version) can't be filtered, so it goes out.
  if (source && shop.orderSources && !shop.orderSources.has(source.toLowerCase())) return `source ${source}`;
  return null;
}

/*
 * Identity binds to an order only through the checkout token in the signed webhook. Anyone can
 * POST /collect, and order ids are guessable, so an order id from the pixel is never used here.
 * A refund goes through the orders row its purchase wrote, which holds the webhook's token.
 */
async function identityFor(store: Store, shop: string, token: string | null | undefined): Promise<Identity | null> {
  return token ? ((await store.getIdentity(shop, token))?.identity ?? null) : null;
}

/** "wait": another consumer holds a fresh claim; come back after CLAIM_WAIT_SECONDS. */
type Outcome = "delivered" | "skipped" | "failed" | "retry" | "wait";

/**
 * Claim first, then send. The claim is a pending `deliveries` row. A second consumer holding the
 * same event skips when the row is done, and otherwise waits past STALE_CLAIM_MS and tries again,
 * so a claim whose holder died mid-send or couldn't release it is taken over instead of lost. A
 * failed or unrecorded send drops the claim so a retry or a later real send can claim again. A send
 * that worked but couldn't be marked done is not retried, but a duplicate that is waiting on its
 * pending claim takes it over once it goes stale and sends again.
 */
async function deliver(
  store: Store,
  target: Target,
  message: QueueMessage,
  identity: Identity | null,
  baseCtx: Omit<TargetContext, "log">,
): Promise<Outcome> {
  const kind: DeliveryKind = message.kind;
  const ref = refId(message);
  const tlog = log.child({ shop: message.shop, kind, ref, target: target.id, attempt: message.attempt });
  const ctx: TargetContext = { ...baseCtx, log: tlog };

  if (kind === "refund" && !target.refund) return "skipped";
  if (!allowed(target.consent, identity)) {
    tlog.info("skipped, no consent", { category: target.consent, identity: identity !== null });
    return "skipped";
  }
  const claim = await store.claimDelivery(message.shop, kind, ref, target.id);
  if (claim === null) {
    if ((await store.deliveryState(message.shop, kind, ref, target.id)) === "done") {
      tlog.info("skipped, already delivered");
      return "skipped";
    }
    tlog.info("claimed by another consumer, waiting for it to finish or go stale");
    return "wait";
  }
  const release = async () => {
    try {
      await store.releaseDelivery(message.shop, kind, ref, target.id, claim);
    } catch (e) {
      tlog.error("releasing the delivery claim failed, the retry waits for it to go stale", { error: e });
    }
  };

  let result: void | DeliveryResult;
  try {
    if (message.kind === "purchase") result = await target.purchase(message.order, identity, ctx);
    else result = await target.refund?.(message.refund, identity, ctx);
  } catch (e) {
    await release();
    // Errors that aren't TargetError are retried too: they're usually transient and attempts are capped.
    const retryable = !(e instanceof TargetError) || e.retryable;
    tlog.error("send failed", { error: e, retryable });
    return retryable ? "retry" : "failed";
  }
  // Debug and test sends aren't recorded, so the real send of this event can still happen later.
  if (result && result.recorded === false) {
    await release();
    if (result.skipped) {
      tlog.debug(`skipped: ${result.skipped}`);
      return "skipped";
    }
    tlog.info("sent, not recorded (debug or test mode)");
    return "delivered";
  }
  try {
    await store.completeDelivery(message.shop, kind, ref, target.id);
  } catch (e) {
    // The event went out. Retrying would send it twice, so this only logs.
    tlog.error("sent, but marking it delivered failed; not retrying", { error: e });
    return "delivered";
  }
  tlog.info("delivered");
  return "delivered";
}

/**
 * "ack": the message is done with, or its follow-up is on the queue. "retry": a re-enqueue failed,
 * so the platform has to redeliver this message. A throw means nothing was sent or re-enqueued yet.
 */
export type MessageOutcome = "ack" | "retry";

export async function processMessage(configFn: ConfigFn, env: WorkerEnv, message: QueueMessage): Promise<MessageOutcome> {
  const mlog = log.child({ shop: message.shop, kind: message.kind, ref: refId(message), attempt: message.attempt });
  const shop = resolveShop(configFn, env, message.shop);
  if (!shop) {
    mlog.warn("dropped, shop no longer accepted");
    return "ack";
  }
  // Messages only come from verified webhooks, so this shop is trusted.
  warnDisabled(shop);

  const store = await openStore(env.DB);
  let identity: Identity | null = null;
  let skip: string | null;
  if (message.kind === "purchase") {
    const { order } = message;
    // Written before any skip, so a refund of a skipped order can follow the same decision.
    await store.putOrder(message.shop, order.id, order.checkoutToken, order.currency, order.createdAt, {
      test: order.test,
      sourceName: order.sourceName,
    });
    skip = orderSkip(shop, order.test, order.sourceName);
    if (!skip) identity = await identityFor(store, message.shop, order.checkoutToken);
  } else {
    const { refund } = message;
    const order = refund.amount > 0 ? await store.getOrder(message.shop, refund.orderId) : null;
    if (!(refund.amount > 0)) {
      skip = "nothing refunded";
    } else if (!order && message.attempt < REFUND_WAIT_ATTEMPTS) {
      // Its purchase may still be in the queue (both webhooks wait PIXEL_WAIT_SECONDS). Without the
      // orders row there's no identity and no test or source decision to follow.
      const next = message.attempt + 1;
      return requeueOrRetry(env, { ...message, attempt: next }, REFUND_WAIT_SECONDS, mlog, () =>
        mlog.info("refund before its purchase, waiting", { nextAttempt: next, delaySeconds: REFUND_WAIT_SECONDS }),
      );
    } else {
      if (order?.currency && !refund.currency) refund.currency = order.currency;
      if (!refund.currency && refund.amountCurrency) refund.currency = refund.amountCurrency;
      if (refund.amountCurrency === refund.currency) delete refund.amountCurrency;
      skip = order ? orderSkip(shop, order.test, order.sourceName) : null;
      if (!skip) identity = await identityFor(store, message.shop, order?.checkoutToken);
    }
  }
  if (skip) {
    mlog.info(`skipped: ${skip}`);
    return "ack";
  }

  const wanted = message.targets;
  const targets = wanted ? shop.targets.filter((t) => wanted.includes(t.id)) : shop.targets;
  const baseCtx = { shop: message.shop, fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) };
  // allSettled: a store error in one target must not abort the others or re-run the ones that worked.
  const settled = await Promise.allSettled(targets.map((t) => deliver(store, t, message, identity, baseCtx)));
  // Targets have run. From here on nothing may throw: consume would re-enqueue the whole message.
  let wait = false;
  const retry = targets
    .filter((t, i) => {
      const s = settled[i]!;
      if (s.status === "fulfilled") {
        if (s.value === "wait") wait = true;
        return s.value === "retry" || s.value === "wait";
      }
      mlog.error("target failed outside the send", { target: t.id, error: s.reason });
      return true;
    })
    .map((t) => t.id);
  if (!retry.length) return "ack";

  if (message.attempt >= MAX_ATTEMPTS) {
    mlog.error("giving up after max attempts", { targets: retry });
    return "ack";
  }
  const next = message.attempt + 1;
  // One message for every target left. A waiting target needs the longer delay, and the others
  // lose nothing by sharing it: they'd be retried anyway.
  const delaySeconds = wait ? Math.max(retryDelaySeconds(next), CLAIM_WAIT_SECONDS) : retryDelaySeconds(next);
  // If this fails, the platform redelivers the original message: targets marked done skip, and a
  // waiting target meets the same fresh claim and waits again, so nothing is lost.
  return requeueOrRetry(env, { ...message, targets: retry, attempt: next }, delaySeconds, mlog, () =>
    mlog.warn("re-enqueued", { targets: retry, nextAttempt: next, delaySeconds }),
  );
}

/**
 * Enqueues the follow-up message. Its success alone decides the outcome: "ack" once it's on the
 * queue, "retry" when it couldn't be put there. Never throws.
 */
async function requeueOrRetry(
  env: WorkerEnv,
  next: QueueMessage,
  delaySeconds: number,
  mlog: Logger,
  logSuccess: () => void,
): Promise<MessageOutcome> {
  try {
    await enqueue(env, next, delaySeconds);
  } catch (e) {
    mlog.error("re-enqueue failed, leaving it to the platform's retry", { error: e, delaySeconds: PLATFORM_RETRY_SECONDS });
    return "retry";
  }
  logSuccess();
  return "ack";
}

function isMessage(m: unknown): m is QueueMessage {
  if (!m || typeof m !== "object") return false;
  const v = m as Partial<Record<string, unknown>>;
  if (typeof v.shop !== "string" || typeof v.attempt !== "number") return false;
  return (v.kind === "purchase" && !!v.order) || (v.kind === "refund" && !!v.refund);
}

/** The platform redelivers a message whose re-enqueue failed after this long. */
export const PLATFORM_RETRY_SECONDS = 60;

/**
 * Retries a message that threw before any target ran (a store error) through our own path, with
 * our backoff and attempt cap. "ack" once the copy is on the queue or the message reached
 * MAX_ATTEMPTS; "retry" when the re-enqueue failed. Never throws.
 */
async function requeueFailed(env: WorkerEnv, message: QueueMessage, error: unknown): Promise<MessageOutcome> {
  const mlog = log.child({ shop: message.shop, kind: message.kind, ref: refId(message), attempt: message.attempt });
  mlog.error("message failed", { error });
  if (message.attempt >= MAX_ATTEMPTS) return "ack";
  const next = message.attempt + 1;
  const delaySeconds = retryDelaySeconds(next);
  return requeueOrRetry(env, { ...message, attempt: next }, delaySeconds, mlog, () =>
    mlog.warn("message re-enqueued", { nextAttempt: next, delaySeconds }),
  );
}

export async function consume(configFn: ConfigFn, batch: MessageBatch<QueueMessage>, env: WorkerEnv): Promise<void> {
  for (const msg of batch.messages) {
    const message = msg.body;
    if (!isMessage(message)) {
      log.error("dropped malformed message", { id: msg.id });
      msg.ack();
      continue;
    }
    let outcome: MessageOutcome = "ack";
    try {
      outcome = await processMessage(configFn, env, message);
    } catch (e) {
      // A store failure before any target ran. Our own re-enqueue retries it.
      outcome = await requeueFailed(env, message, e);
    } finally {
      // Acked whenever our own path has it covered: an unacked message is redelivered by the
      // platform, which would run it again next to our re-enqueued copy. Only a message we
      // couldn't re-enqueue goes back to the platform, within its max_retries.
      if (outcome === "ack") msg.ack();
      else msg.retry({ delaySeconds: PLATFORM_RETRY_SECONDS });
    }
  }
}
