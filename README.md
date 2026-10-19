# Server Side Analytics Worker for Shopify

Send Shopify purchases and refunds to GA4, server-side GTM, Meta and Awin from a Cloudflare Worker. Orders come from Shopify webhooks, so every one is counted, ad blockers or not. Each "target" is defined in a target implementation file and adding new ones is easy.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/adrianocr/ssa-worker-shopify)

## Why server-side

A standalone browser pixel on the order status page can miss orders. Ad blockers will drop it, consent banners race it, and Shop Pay checkouts run on a different domain where your `_ga` cookie doesn't exist. So you end up with revenue in Shopify that doesn't match revenue in GA4 or Meta and you can't say by how much.

But Shopify's webhooks don't have that problem because Shopify sends one for every order and every refund signed with a secret only you and Shopify know. This worker takes them from there.

What the server can't do is read the visitor's browser because attribution needs the `_ga` cookie, `_fbp`, `_fbc`, and click ids like `fbclid` and `awc`. So a small Shopify custom pixel collects those at checkout and sends them to the worker. The pixel never reports purchases. If it fails or gets blocked, the purchase still goes out, with less attribution.

## What it does

```
 Browser                          Shopify                    Your Worker
 -------                          -------                    -----------
 custom pixel                                                POST /collect
 (cookies, click ids,  ------------------------------------> stores identity
  consent) at checkout                                       in D1, 204

                       order placed
                                  orders/create  ---------> POST /webhooks/shopify
                                  refunds/create             verify HMAC
                                  (signed)                   enqueue, delay 120s, 200

                                                             Queue consumer
                                                             load identity from D1
                                                             check consent per target
                                                                 |
                                                                 +--> GA4
                                                                 +--> server-side GTM
                                                                 +--> Meta
                                                                 +--> Awin
                                                             failed target: retry that
                                                             target only, with backoff
```

The 120 second delay gives the pixel's request time to land before the worker looks up identity. [How it works](docs/how-it-works.md) has the details.

## Supported targets

| Target | Purchase | Refund | Consent category | Setup |
|---|---|---|---|---|
| GA4 | yes | yes | analytics | [docs/targets/ga4.md](docs/targets/ga4.md) |
| Server-side GTM | yes | yes | analytics | [docs/targets/sgtm.md](docs/targets/sgtm.md) |
| Meta Conversions API | yes | no | marketing | [docs/targets/meta.md](docs/targets/meta.md) |
| Awin | yes | no | marketing | [docs/targets/awin.md](docs/targets/awin.md) |

TikTok isn't built. There are notes in [docs/targets/tiktok.md](docs/targets/tiktok.md) if you want to write it.

A target with missing credentials turns itself off and logs which values it's missing. You only configure the ones you use.

## Setup

Five steps, in this order. The worker has to exist before Shopify can call it, and the webhook gives you the secret the worker needs.

### 1. Deploy the worker

**With the button.** Click Deploy to Cloudflare at the top, connect GitHub, and follow the prompts. It forks the repo, creates the D1 database and deploys. When it asks for `SHOPIFY_WEBHOOK_SECRET`, type any placeholder. You don't have the real value yet (step 2 gives it to you).

If the button's deploy fails with a queue error, create the queue with the CLI path below. `wrangler deploy` creates D1 on its own but not Queues.

**With the CLI.**

```bash
git clone https://github.com/adrianocr/ssa-worker-shopify
cd ssa-worker-shopify
npm ci
npx wrangler login
npm run setup     # creates the ssa-events queue, once
npm run deploy
```

D1 is created by `npm run deploy`. There's no database id to paste and no migration to run. The tables are created on first use.

Wrangler prints the worker URL, something like `https://ssa-worker-shopify.your-subdomain.workers.dev`. You need it in the next two steps.

### 2. Create the Shopify webhooks

In the Shopify admin go to Settings > Notifications > Webhooks and click Create webhook twice.

| Event | Format | URL | Webhook API version |
|---|---|---|---|
| Order creation | JSON | `https://<worker>/webhooks/shopify` | the one marked Latest |
| Refund create | JSON | `https://<worker>/webhooks/shopify` | the one marked Latest |

Same URL for both. The worker reads the topic from a header.

The Webhooks page shows the signing secret in a line that reads "Your webhooks will be signed with ...". Copy it, then set it on the worker:

```bash
npx wrangler secret put SHOPIFY_WEBHOOK_SECRET
```

Until the secret matches, every webhook gets a 401, and Shopify deletes a webhook that keeps failing. Use Send test from the webhook's menu to check: `npx wrangler tail` should show `webhook enqueued`. Shopify's sample order is a test order, so the queue then logs `skipped: test order`. That's expected.

Webhooks name the shop by its permanent domain, which can differ from the one in your admin URL. A store at `admin.shopify.com/store/my-shop` might send `x7y8z9-ab.myshopify.com`. The logs show the domain Shopify sends, and that's the one to use in `SHOP_DOMAINS` and `STORES`.

### 3. Add the custom pixel

1. In the Shopify admin go to Settings > Customer events > Add custom pixel. Name it anything.
2. Open `pixel/custom-pixel.js`, paste the whole file into the Code window.
3. Change `WORKER_URL` at the top to your worker URL, no trailing slash. If you use GA4, you can also set `GA4_MEASUREMENT_ID` (optional, used as a fallback to read the GA4 session cookie).
4. Under Customer privacy, set Permission and Data sale (below).
5. Save, then Connect.

Set Permission to **Required** and tick only **Analytics**. Shopify ticks Marketing too by default, so untick it.

- Shopify runs the pixel only for visitors who accepted analytics. Nothing is read from anyone else, not even cookies.
- The pixel still reports each visitor's full consent flags, and the worker enforces them per target. A visitor who accepted analytics but not marketing gets their `_ga` linked to the purchase for GA4, and the Meta and Awin events are skipped.
- Ticking Marketing as well is stricter. Shopify then skips analytics-only visitors entirely, so GA4 loses their session link.

**Not required** also works, because the worker still gates every send on consent. The pixel then reads cookies before the visitor has chosen, which is a gray area under GDPR. Pick it only if your legal setup allows that.

Data sale defaults to "Data collected qualifies as data sale". With it, the pixel doesn't run for visitors who opted out of the sale of their data. Meta and Awin get customer details, so the default is the safe choice if you use them.

Before you connect, remove any other tracking pixel for the same destinations (theme code, Additional scripts) so you don't count orders twice.

To check it works, set `DEBUG = true` in the pixel, open your store, add something to the cart and start a checkout. The browser console shows `[ssa-pixel] POST /collect` and `/collect responded 204`. Set it back to `false` afterwards.

### 4. Add target credentials

Set each value as a secret. Secrets survive redeploys, which plain dashboard variables may not.

```bash
npx wrangler secret put GA4_MEASUREMENT_ID
npx wrangler secret put GA4_API_SECRET
```

| Target | Variable | Required | What it is |
|---|---|---|---|
| GA4 | `GA4_MEASUREMENT_ID` | yes | `G-XXXXXXXXXX` |
| GA4 | `GA4_API_SECRET` | yes | Measurement Protocol API secret |
| GA4 | `GA4_DEBUG` | no | `true` validates payloads without recording them |
| sGTM | `SGTM_URL` | yes | Full collect URL, for example `https://sgtm.example.com/mp/collect` |
| sGTM | `SGTM_MEASUREMENT_ID` | no | Appended as `measurement_id`; also used to find the GA4 session cookie |
| sGTM | `SGTM_API_SECRET` | no | Appended as `api_secret` |
| Meta | `META_PIXEL_ID` | yes | Dataset (pixel) id |
| Meta | `META_ACCESS_TOKEN` | yes | Conversions API access token |
| Meta | `META_TEST_EVENT_CODE` | no | Sends events to the Test events tab |
| Meta | `META_API_VERSION` | no | Graph API version, defaults to `v25.0` |
| Meta | `META_CONTENT_ID` | no | `variant_id` (default), `sku` or `product_id`: which id goes in `content_ids` |
| Awin | `AWIN_ADVERTISER_ID` | yes | Your advertiser id |
| Awin | `AWIN_API_KEY` | yes | Conversion API key |
| Awin | `AWIN_COMMISSION_GROUP` | no | Commission group code, defaults to `DEFAULT` |
| Awin | `AWIN_TEST` | no | `true` marks orders as tests so Awin doesn't track them |
| Awin | `AWIN_COOKIE_DAYS` | no | Days before the order an `awc` click counts, default `30`. Match your program's cookie length |

Where to find each one, step by step: [GA4](docs/targets/ga4.md), [sGTM](docs/targets/sgtm.md), [Meta](docs/targets/meta.md), [Awin](docs/targets/awin.md).

GA4 also needs a GA4 tag on the storefront. The worker sends the purchase, but only a tag in the browser sets the `_ga` cookie that ties it to a visitor and a traffic source. Shopify's Google & YouTube app adds one, or you can paste Google's gtag snippet into `layout/theme.liquid`. Either way, don't let the browser tag send purchases as well, or every order counts twice.

### 5. Verify

Watch the logs while you place a test order:

```bash
npx wrangler tail
```

Shopify flags orders from its Bogus Gateway or a payment provider's test mode as test orders, and the worker skips those by default (`skipped: test order`). While you verify, set `SEND_TEST_ORDERS` to `true`, and delete it afterwards:

```bash
npx wrangler secret put SEND_TEST_ORDERS      # true
npx wrangler secret delete SEND_TEST_ORDERS   # when you're done
```

You should see `webhook enqueued` right away and, about two minutes later, `delivered` once per target. A line saying `skipped, no consent` means the visitor said no to that target's category. `target disabled, missing config` lists the variables you haven't set.

Each target has a safe test mode:

- GA4: set `GA4_DEBUG` to `true`. The worker sends to Google's validation endpoint and logs any `validationMessages`. Nothing is recorded in GA4.
- Meta: set `META_TEST_EVENT_CODE` from the Test events tab. The event shows up there. It is still a real event, so unset the code when you're done.
- Awin: orders are real unless you mark them as tests. Set `AWIN_TEST` to `true` and Awin won't track them. Unset it afterwards.

Debug and test sends aren't recorded as delivered. The logs say `sent, not recorded (debug or test mode)` instead of `delivered`. If Shopify sends the same order's webhook again after you switch test mode off, it goes out for real.

## Several stores

One worker can serve many stores. Set a `STORES` secret with JSON keyed by each store's `*.myshopify.com` domain. Values use the same variable names as above. Anything a store doesn't set falls back to the worker's own variables.

```json
{
  "first-example-store.myshopify.com": {
    "SHOPIFY_WEBHOOK_SECRET": "abc123...",
    "GA4_MEASUREMENT_ID": "G-AAAAAAAAAA",
    "GA4_API_SECRET": "secret-one",
    "META_PIXEL_ID": "111111111111111",
    "META_ACCESS_TOKEN": "token-one"
  },
  "second-example-store.myshopify.com": {
    "SHOPIFY_WEBHOOK_SECRET": "def456...",
    "GA4_MEASUREMENT_ID": "G-BBBBBBBBBB",
    "GA4_API_SECRET": "secret-two"
  }
}
```

```bash
npx wrangler secret put STORES < stores.json
```

Each store has its own signing secret, so each entry needs its own `SHOPIFY_WEBHOOK_SECRET`. Every store's pixel uses the same `WORKER_URL`. `SHOP_DOMAINS` is a comma-separated list of domains. When `STORES` or `SHOP_DOMAINS` is set, the worker accepts a shop named in either one (the union of both) and rejects every other shop. A shop only in `SHOP_DOMAINS` uses the worker's own variables.

Set `SHOP_DOMAINS` on every deploy, even for one store:

```bash
npx wrangler secret put SHOP_DOMAINS   # your-store.myshopify.com
```

Without `STORES` and without `SHOP_DOMAINS`, any shop whose webhook verifies against `SHOPIFY_WEBHOOK_SECRET` is accepted. Webhooks are still safe that way, but `/collect` then accepts identity for any `*.myshopify.com` name, so anyone can fill your D1 database with rows for shops you don't run.

## Consent

Shopify has four consent categories: `analytics`, `marketing`, `preferences` and `sale_of_data`. Each target declares one. GA4 and sGTM use analytics. Meta and Awin use marketing.

The rule: the visitor's explicit choice wins. If the pixel never reported a choice (blocked, or the visitor never reached checkout with it), analytics targets send and marketing targets skip.

| What the worker knows | Analytics target | Marketing target |
|---|---|---|
| Visitor said yes | sends | sends |
| Visitor said no | skips | skips |
| Nothing known | sends | skips |

The reasoning: revenue totals in GA4 should stay correct even when the pixel is missing, and an anonymous purchase with no cookies carries no personal data. Marketing platforms get customer details, so they need a yes.

## Configuration reference

Variables go in `.dev.vars` locally and in secrets (or Settings > Variables and Secrets) in production. `.dev.vars.example` has a template.

| Variable | Default | What it does |
|---|---|---|
| `SHOPIFY_WEBHOOK_SECRET` | none | Signing secret for webhooks. Required unless every store sets its own in `STORES`. |
| `STORES` | none | JSON per-store overrides, see above. Its keys are also allowed shops. |
| `SHOP_DOMAINS` | none | Comma-separated allowlist of `*.myshopify.com` domains. Accepted shops are these plus the `STORES` keys. Set it on every deploy. |
| `PIXEL_WAIT_SECONDS` | `120` | How long a webhook waits in the queue before processing. Max 43200 (12 hours, a Queues limit). |
| `SEND_TEST_ORDERS` | `false` | `true` sends orders Shopify flags as test orders, and their refunds. Otherwise every target skips them. |
| `ORDER_SOURCES` | `web` | Comma-separated Shopify `source_name` values to send, for example `web,pos`. `*` sends every source. Other orders, and their refunds, are skipped. |
| `GA4_MEASUREMENT_ID`, `GA4_API_SECRET`, `GA4_DEBUG` | none, none, `false` | GA4 target. |
| `SGTM_URL`, `SGTM_MEASUREMENT_ID`, `SGTM_API_SECRET` | none | Server-side GTM target. |
| `META_PIXEL_ID`, `META_ACCESS_TOKEN`, `META_TEST_EVENT_CODE` | none | Meta target. |
| `META_API_VERSION` | `v25.0` | Meta Graph API version. |
| `META_CONTENT_ID` | `variant_id` | Which line id Meta gets in `content_ids`: `variant_id`, `sku` or `product_id`. Case and spaces don't matter. Anything else logs a warning once and uses `variant_id`. |
| `AWIN_ADVERTISER_ID`, `AWIN_API_KEY`, `AWIN_COMMISSION_GROUP` | none | Awin target. |
| `AWIN_TEST` | `false` | `true` sends Awin orders as tests. |
| `AWIN_COOKIE_DAYS` | `30` | How old an `awc` click may be when the order is placed and still count, and the window for the last-click `channel`. |

Target variables, `SEND_TEST_ORDERS` and `ORDER_SOURCES` can also be set per store inside `STORES`.

`/collect` also has a rate limit, set in `wrangler.jsonc` (`COLLECT_LIMITER`, 60 requests a minute per IP). It isn't a variable. See [Limits and caveats](#limits-and-caveats).

`src/config.ts` is the one file you edit. It lists the targets and maps variables to them. Everything under `src/targets/` stays as it is.

## Adding a target

A target is one file that says what to send for a purchase, and optionally for a refund. Add it to `src/config.ts` with one import and one array entry. [docs/writing-a-target.md](docs/writing-a-target.md) walks through a complete example, and [docs/targets/tiktok.md](docs/targets/tiktok.md) has notes for a likely first candidate.

## Local development

```bash
npm ci
cp .dev.vars.example .dev.vars   # fill in SHOPIFY_WEBHOOK_SECRET and any target you want to try
npm run dev
npm run typecheck
npm test
```

To send a signed test order to the local worker:

```bash
SECRET=your-dev-secret
BODY=$(cat test/fixtures/orders-create.json)
SIG=$(printf %s "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64)
curl -i http://localhost:8787/webhooks/shopify \
  -H "X-Shopify-Topic: orders/create" \
  -H "X-Shopify-Shop-Domain: dev-store.myshopify.com" \
  -H "X-Shopify-Hmac-Sha256: $SIG" \
  --data-binary "$BODY"
```

Tests run with Vitest inside the Workers runtime. Targets are tested with a fake `fetch`, so no test hits a real API.

## Limits and caveats

- **Meta and Awin have no refunds.** Meta's Conversions API has no refund event, and I'm not using any Awin call that reverses an order. Those targets skip refunds. GA4 and sGTM send a `refund` event.
- **Awin needs `awc`.** The click id has to be in the visitor's URL when they land, and the pixel has to have seen it. Orders without one are skipped with a debug log, `skipped: no awc click id`, since most orders aren't from Awin. An `awc` that was older than `AWIN_COOKIE_DAYS` when the order was placed is skipped the same way (`skipped: awc older than 30 days`).
- **Only online store orders by default.** `ORDER_SOURCES` defaults to `web`, so POS, draft orders and orders from other sales channels are skipped (`skipped: source pos`). Test orders are skipped unless `SEND_TEST_ORDERS` is `true`. A refund follows its order: if the order was skipped, so is the refund.
- **Refunds with nothing refunded are skipped.** A refund whose transactions are all pending or failed returns no money, so no target gets it (`skipped: nothing refunded`).
- **A refund can wait for its purchase.** When a refund arrives and its order hasn't been processed yet, the worker puts it back on the queue for 5 minutes, twice. After that it sends the refund without identity.
- **Orders with thousands of lines lose items, not revenue.** A queue message can't be over 128 KB. When an order or refund would pass 100 KB, the worker drops lines from the end until it fits, sets `linesTruncated`, and logs `queue message too large, lines truncated`. Totals stay complete, and so do the item count and the refunded line subtotal, which are worked out from every line before any are dropped. Revenue, the GA4 and sGTM refund `value` and Meta's `num_items` are unaffected; only the item list is short.
- **Meta rejects events older than 7 days.** The worker logs a warning for an order older than that and skips it (`skipped: order older than 7 days` at debug level).
- **Pixel identity is best effort.** Blocked pixel, closed tab, or a browser that clears storage: the purchase still goes out, with less attribution. GA4 falls back to the order id as `client_id`, so the sale counts as a new user.
- **Free plan quotas.** Queues on the Workers Free plan allows 10,000 operations a day, and each message costs roughly three (write, read, delete). Retries add more. D1 on Free allows 100,000 rows written a day. An order writes a handful of rows. Both are fine for small stores. Check Cloudflare's pricing pages if you're near a few thousand orders a day.
- **`/collect` is rate limited per IP.** The `COLLECT_LIMITER` binding in `wrangler.jsonc` allows 60 requests a minute per IP, so a flood can't burn the D1 write quota. Over the limit the worker answers 429. Cloudflare counts per location and calls the limit eventually consistent, so treat it as a brake, not an exact count. Workers on one account that share a `namespace_id` share counters, so change it if another worker of yours uses `48213`. If a deploy rejects the binding, delete the `ratelimits` block. The worker skips the check when the binding is missing.
- **Retries stop after 8 attempts.** The delay doubles from one minute. After the last attempt, the failure is logged and the message is dropped.
- **Data retention.** Identities that never matched an order are deleted after 7 days. Everything else goes after 400 days. A daily cron does it.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
