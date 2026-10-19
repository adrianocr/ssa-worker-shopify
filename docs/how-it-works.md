# How it works

Three pieces: a custom pixel in the browser, Shopify webhooks, and a Worker with a queue and a D1 database.

## The split

Purchases and refunds come only from Shopify webhooks. The pixel only supplies identity: the cookies and click ids that tie an order to an ad click or a GA4 user. If the pixel is blocked, the order is still sent, with less attribution.

This split is the whole design. The old way, firing a purchase tag from the browser, loses every order the browser doesn't cooperate on.

## The pixel

`pixel/custom-pixel.js` runs in Shopify's customer events sandbox.

- On every `page_viewed` it looks for `gclid`, `gbraid`, `wbraid`, `fbclid`, `ttclid`, `msclkid` and `awc` in the URL and keeps them in the browser's `localStorage`. Nothing is sent yet. Last click wins.
- On `checkout_started` and `checkout_completed` it sends one `POST /collect` with the shop domain, the checkout token, Shopify's client id, the cookies `_ga`, `_ga_*`, `_fbp`, `_fbc` and `_ttp`, the stored click ids, the consent flags and the checkout URL.
- The request is `text/plain` with a JSON body, which browsers send without a CORS preflight.

It never sends order totals, items, emails or any customer detail.

## `POST /collect`

Checks the per-IP rate limit first (the `COLLECT_LIMITER` binding, 60 requests a minute; 429 when exceeded, skipped when the binding isn't configured). Then it validates the body (16 KB max, 413 when larger; known shop; well-formed fields) and upserts a row in `identities` keyed by shop and checkout token. A second call for the same token merges: newer values win, but a click id seen again with the same value keeps its first-seen time. An `orderId` field, which older versions of the pixel send, is accepted and ignored. Anyone can call `/collect` and order ids are easy to guess, so the worker never joins on one. It adds the request's `CF-Connecting-IP` and `User-Agent`, and answers 204. It never triggers a send.

## `POST /webhooks/shopify`

1. Read the raw body as bytes, at most 1 MB. A larger body gets a 413 before the shop or signature is checked. Find the shop from `X-Shopify-Shop-Domain`. Unknown shop: 401.
2. Verify `X-Shopify-Hmac-Sha256` over those bytes against that shop's signing secret, in constant time. Mismatch: 401. Only then is the body decoded and parsed.
3. Topics other than `orders/create` and `refunds/create` get a 200 and are ignored.
4. Normalize the payload into a neutral `Order` or `Refund` (see `src/core/types.ts`). Malformed payload: 400.
5. Put it on the `ssa-events` queue with `delaySeconds` set to `PIXEL_WAIT_SECONDS` (default 120). If the queue refuses it, answer 500 so Shopify retries the webhook.

Amounts come from Shopify's `*_set.shop_money` fields, in the shop's currency, with the plain fields as a fallback. On an order paid in another currency the presentment amounts are in the buyer's currency, and mixing the two would put a refund in one currency against a purchase in another. Refund transactions only have an amount in the currency they were paid in, so that amount keeps its own currency.

A message over 100 KB (Queues allows 128 KB) has its `lines` cut until it fits, with `linesTruncated` set and a warning logged. Totals stay complete, and so do `Order.itemCount` and `Refund.linesAmount`, which are computed from every line during normalization. The GA4 and sGTM refund `value` and Meta's `num_items` use them, so they don't shrink with the item list.

The delay is there because the pixel's `/collect` request and Shopify's webhook race each other. Waiting two minutes makes the pixel win nearly every time.

## The consumer

For each message the queue consumer:

1. Resolves the shop's config and its enabled targets.
2. For a purchase, records the order with its checkout token, currency, Shopify's `test` flag and `source_name`, so later refunds can follow it. This happens before any skip.
3. Skips the whole message, for every target, when:
   - it's a test order and `SEND_TEST_ORDERS` isn't `true` (`skipped: test order`);
   - its `source_name` isn't in `ORDER_SOURCES`, default `web` (`skipped: source pos`). An order with no `source_name` is sent;
   - it's a refund with nothing refunded (`skipped: nothing refunded`).
4. A refund whose order row isn't there yet goes back on the queue for 300 seconds, until its third attempt. Then it goes ahead without identity. A refund whose order row is there is skipped when that order was skipped for its test flag or source. The waits count toward the attempt limit, so a refund that waited twice has five retries left.
5. Loads identity, only through the checkout token from the signed webhook. For a purchase: the order's `checkout_token`. For a refund: it finds the stored order row by order id and follows that to its checkout token. Nothing else is tried, so a purchase without a token, or a refund whose order row is gone, has no identity.
6. For each target, in parallel: skips it if the shop's consent says no, then claims the delivery (see Idempotency) and sends. A delivery already done means skip. A claim another consumer still holds means wait: that target comes back after the claim has had time to go stale.
7. After a successful send it marks the delivery done, unless the target returned `{ recorded: false }` (debug and test sends, and orders a target skipped on purpose). Then, as after a failed send, it drops the claim.
8. Any target that failed or is waiting on a claim is re-enqueued, including one whose claim threw before the send. The others keep their result.

### Consent

`allowed = identity?.consent[category] ?? (category === "analytics")`. An explicit `false` always skips. Unknown consent lets analytics targets through and holds marketing targets back.

### Retries

A message leaves the consumer one of two ways: acked, when it's done with or its follow-up is on the queue, or handed back to Cloudflare with `retry()`, when the worker couldn't put a follow-up on the queue. Logging can't change which: the logger catches its own console errors. There are four retry paths.

**Per-target re-enqueue.** After the targets run, the ones that need another try go back on the queue in one message, and the original is acked.

- A `TargetError` with `retryable: true` (network error, timeout, 429, 5xx), or any other thrown error, puts that target back on the queue.
- The re-enqueued message lists only the targets that failed, so targets that succeeded aren't called again.
- Delay before attempt 2 is 60 seconds, then 120, 240 and so on, capped at 12 hours.
- A target waiting on another consumer's claim comes back after 11 minutes (`STALE_CLAIM_MS` plus a minute), or the retry delay when that's longer. The message carries one delay, so the targets that failed alongside it wait as long. This counts as an attempt.
- After attempt 8, the worker logs an error and drops the message.
- A `TargetError` with `retryable: false` (a 4xx other than 429) is logged and not re-enqueued (a platform redelivery of the whole message can still call it once more).

**Whole-message re-enqueue.** A store error before any target ran (opening the store, writing the orders row, reading identity) re-enqueues the whole message with the same backoff and attempt limit, and the original is acked.

**Platform retry.** If either re-enqueue fails, or a refund waiting for its purchase can't be put back, the worker doesn't ack. It calls `retry()` with a 60 second delay and Cloudflare redelivers the original message. A message that ran its targets isn't re-enqueued a second way on top: the redelivered copy goes through the claims below, so targets already `done` are skipped, a target that failed (retryable or not) is called again, and a target waiting on a fresh claim meets the same claim and waits again for 11 minutes, so the shorter delay doesn't lose it.

**Crash redelivery.** Cloudflare redelivers messages the consumer hadn't acked when its isolate died. Explicitly acked messages are never redelivered, even when the consumer fails later in the batch, so nothing the worker acked runs twice. A redelivered message runs the claim logic like any other copy. Redelivery doesn't add an attempt to the message body, so the worker's own retries still stop at attempt 8.

The last two paths share `max_retries: 3`. After 3 platform retries Cloudflare deletes the message, because no dead-letter queue is configured ([Batching, Retries and Delays](https://developers.cloudflare.com/queues/configuration/batching-retries/)). To keep those messages instead, create a queue and set it as the consumer's `dead_letter_queue` in `wrangler.jsonc`.

### Idempotency

Shopify can deliver a webhook twice, and two copies can be in the queue at the same time. The `deliveries` table has a primary key of shop, kind, reference id and target. The reference id is the order id for purchases and the refund id for refunds.

The worker claims a row before it sends, not after:

1. `INSERT OR IGNORE` a row with state `pending` and the claim time. If the insert added the row, this consumer owns the send.
2. If the row was already there, it's either `done`, or `pending` from another consumer. A `pending` row older than 10 minutes belongs to a consumer that died mid-send or couldn't delete its claim, so one conditional `UPDATE` takes it over. Only one consumer can win that update. A `done` row is skipped (`skipped, already delivered`). A younger `pending` row puts the target back on the queue for 11 minutes (`claimed by another consumer, waiting for it to finish or go stale`). By then the row is either `done`, and the target is skipped, or stale, and the target takes it over. Skipping here would lose the event: the redelivered copy of a crashed consumer's message meets its own fresh `pending` row, and a holder that was alive but couldn't release its claim leaves one too, so waiting and taking over is what recovers both.
3. After a successful send the row becomes `done`.
4. After a failed send, or a send that isn't recorded, the consumer deletes its own pending row, so the retry can claim again.

The one gap: if the send worked but marking the row `done` fails, the worker logs `sent, but marking it delivered failed; not retrying` and doesn't re-enqueue that target, because the event already went out. Its `pending` row stays. Any later copy of the message that includes that target, either a duplicate webhook or a platform retry of the same message (after a queue failure on another target's re-enqueue, or a crash), finds the row stale or waits until it is, then takes it over and sends a second time. That needs a D1 write failure right after a successful send and a second copy of the message, so it's accepted: the other choice, skipping on a fresh claim, loses the event whenever a consumer dies mid-send.

If deleting a claim after a failed send also fails, the error is logged (`releasing the delivery claim failed, the retry waits for it to go stale`). A retry that comes within 10 minutes of the claim finds it still fresh, waits 11 minutes, and then takes it over and sends. A later retry finds it stale and takes it over at once.

Debug and test sends are the exception. GA4 with `GA4_DEBUG`, Meta with `META_TEST_EVENT_CODE` and Awin with `AWIN_TEST` return `{ recorded: false }`, so no row is written and a later real send of the same order can still go out.

## Storage

D1, not KV. Free KV allows 1,000 writes a day and reads can be stale across locations. Identity written at checkout has to be readable two minutes later.

| Table | Key | Holds |
|---|---|---|
| `identities` | shop, checkout token | JSON identity, updated time (an `order_id` column is still there from older versions, unused) |
| `orders` | shop, order id | checkout token, currency, created time, test flag, source name |
| `deliveries` | shop, kind, reference id, target | state (`pending` or `done`), claim time, delivered time |

The tables are created with `CREATE TABLE IF NOT EXISTS` on first use, once per isolate. That's why there's no migration step. Columns added later (`orders.test`, `orders.source_name`, `deliveries.state`, `deliveries.claimed_at`) are added with `ALTER TABLE` when a table doesn't have them yet. Existing `deliveries` rows were all written after a successful send, so they default to `done`. Order rows from before the new columns have no test flag or source, and their refunds are sent.

A cron trigger (03:17 UTC daily) deletes identities with no `orders` row for their checkout token after 7 days, and identities, orders and deliveries after 400 days. 400 days is long enough for a late refund to find its order.

## Config

`src/config.ts` is a function from variables to a list of targets. The variables are the worker's env merged with the shop's `STORES` entry. A target whose required values are missing turns itself off and logs `target disabled, missing config` once per shop and isolate. It doesn't throw. The warning only appears for a shop that sent a webhook that passed HMAC, or one named in `SHOP_DOMAINS` or `STORES`, so a made-up shop header can't fill the logs. The per-shop config cache keeps at most 100 shops.
