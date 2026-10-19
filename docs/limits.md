# Limits and caveats

## What gets sent

- **Only online store orders, by default.** `ORDER_SOURCES` defaults to `web`, so POS, draft orders and other sales channels are skipped (`skipped: source pos`). Test orders are skipped unless `SEND_TEST_ORDERS` is `true`. A refund follows its order: if the order was skipped, so is the refund.
- **Meta and Awin don't get refunds.** Meta's Conversions API has no refund event, and the worker doesn't use any Awin call that reverses an order. GA4 and server-side GTM get a `refund` event.
- **Awin needs an `awc` click id.** It has to be in the URL the visitor landed on, and the pixel has to have seen it. Most orders don't come from Awin, so orders without one are skipped quietly (`skipped: no awc click id`). So is an `awc` that was older than `AWIN_COOKIE_DAYS` when the order was placed.
- **Meta rejects events older than 7 days.** The worker skips those orders (`skipped: order older than 7 days`).
- **Refunds that didn't refund anything are skipped.** If every transaction on a refund is pending or failed, no money moved, so no target gets it (`skipped: nothing refunded`).

## Identity

- **The pixel is best effort.** If it's blocked, the tab closes, or the browser clears its storage, the purchase still goes out with less attribution. GA4 then uses the order id as the `client_id`, so the sale counts as a new user.
- **A refund can wait for its purchase.** If a refund arrives before its order has been processed, the worker puts it back on the queue for 5 minutes, up to twice. After that it sends the refund without identity.

## Size and retries

- **Very large orders lose items, not revenue.** A queue message can't be over 128 KB. If an order or refund would pass 100 KB, the worker drops lines from the end until it fits and logs `queue message too large, lines truncated`. Totals, the item count and the refunded line subtotal are worked out from every line before any are dropped, so revenue and refund values stay right. Only the item list is short.
- **Retries stop after 8 attempts.** The delay doubles each time, starting at one minute. After the last attempt the failure is logged and the message is dropped.

## Cloudflare

- **Free plan quotas.** Queues on the Workers Free plan allow 10,000 operations a day, and each order or refund costs about three (write, read, delete), plus any retries. D1 on Free allows 100,000 rows written a day, and an order writes a handful. Both are plenty for a small store. If you're near a few thousand orders a day, check Cloudflare's pricing pages.
- **`/collect` is rate limited.** The `COLLECT_LIMITER` binding in `wrangler.jsonc` allows 60 requests a minute per IP, so a flood can't burn through your D1 write quota. Over the limit, the worker answers 429. Cloudflare counts per location and only roughly, so treat it as a brake rather than an exact count. Workers on the same account that share a `namespace_id` share counters, so change it if another worker of yours already uses `48213`. If a deploy rejects the binding, delete the `ratelimits` block, and the worker skips the check.
- **Data retention.** Identities that never matched an order are deleted after 7 days. Everything else is deleted after 400 days, by a daily cron.
