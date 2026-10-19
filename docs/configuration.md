# Configuration

Everything is set with environment variables. Locally they go in `.dev.vars` (copy `.dev.vars.example`). In production, set them as secrets with `npx wrangler secret put NAME`, because secrets survive redeploys and plain dashboard variables may not.

The only file you edit is [`src/config.ts`](../src/config.ts). It lists the targets and maps variables to them. Everything under `src/targets/` stays as it is.

## General

| Variable | Default | What it does |
|---|---|---|
| `SHOPIFY_WEBHOOK_SECRET` | none | Signing secret for webhooks. Required unless every store sets its own in `STORES`. |
| `SHOP_DOMAINS` | none | Comma-separated list of the `*.myshopify.com` domains this worker serves. Set it on every deploy, even for one store. |
| `STORES` | none | JSON with per-store settings. See [Several stores](#several-stores). |
| `PIXEL_WAIT_SECONDS` | `120` | How long a webhook waits in the queue before it's processed. Max 43200 (12 hours, a Queues limit). |
| `SEND_TEST_ORDERS` | `false` | `true` sends orders Shopify flags as test orders, and their refunds. |
| `ORDER_SOURCES` | `web` | Comma-separated Shopify `source_name` values to send, for example `web,pos`. `*` sends every source. |

Without `SHOP_DOMAINS` or `STORES`, the worker accepts any shop whose webhook verifies against `SHOPIFY_WEBHOOK_SECRET`. Webhooks are still safe that way, but `/collect` will then store identity for any `*.myshopify.com` name, so anyone could fill your database with rows for shops you don't run.

Use each store's permanent domain, which can differ from the name in your admin URL. A store at `admin.shopify.com/store/my-shop` might send `x7y8z9-ab.myshopify.com`. Send a test webhook and `npx wrangler tail` shows the domain Shopify uses.

## Targets

| Target | Variable | Required | What it is |
|---|---|---|---|
| GA4 | `GA4_MEASUREMENT_ID` | yes | `G-XXXXXXXXXX` |
| GA4 | `GA4_API_SECRET` | yes | Measurement Protocol API secret |
| GA4 | `GA4_DEBUG` | no | `true` validates events without recording them |
| sGTM | `SGTM_URL` | yes | Full collect URL, for example `https://sgtm.example.com/mp/collect` |
| sGTM | `SGTM_MEASUREMENT_ID` | no | Appended as `measurement_id`, and used to find the GA4 session cookie |
| sGTM | `SGTM_API_SECRET` | no | Appended as `api_secret` |
| Meta | `META_PIXEL_ID` | yes | Dataset (pixel) id |
| Meta | `META_ACCESS_TOKEN` | yes | Conversions API access token |
| Meta | `META_TEST_EVENT_CODE` | no | Sends events to the Test events tab |
| Meta | `META_API_VERSION` | no | Graph API version, default `v25.0` |
| Meta | `META_CONTENT_ID` | no | Which id goes in `content_ids`: `variant_id` (default), `sku` or `product_id` |
| Awin | `AWIN_ADVERTISER_ID` | yes | Your advertiser id |
| Awin | `AWIN_API_KEY` | yes | Conversion API key |
| Awin | `AWIN_COMMISSION_GROUP` | no | Commission group code, default `DEFAULT` |
| Awin | `AWIN_TEST` | no | `true` marks orders as tests so Awin doesn't track them |
| Awin | `AWIN_COOKIE_DAYS` | no | How many days an `awc` click counts for, default `30`. Match your program's cookie length. |

Each target's page says where to find its values: [GA4](targets/ga4.md), [server-side GTM](targets/sgtm.md), [Meta](targets/meta.md), [Awin](targets/awin.md).

## Testing safely

Shopify flags orders from its Bogus Gateway, or from a payment provider's test mode, as test orders. The worker skips them (`skipped: test order`) unless you turn them on:

```bash
npx wrangler secret put SEND_TEST_ORDERS      # true
npx wrangler secret delete SEND_TEST_ORDERS   # when you're done
```

Each target also has a mode that keeps test data out of your real reports:

- **GA4:** set `GA4_DEBUG` to `true`. Events go to Google's validation endpoint, and the logs show any problems Google finds. Nothing is recorded.
- **Meta:** set `META_TEST_EVENT_CODE` from the Test events tab. Events show up there. Remove the code when you're done.
- **Awin:** set `AWIN_TEST` to `true`, and Awin won't track the orders. Remove it afterwards.

Sends in these modes aren't marked as delivered, so the logs say `sent, not recorded (debug or test mode)`. That means if Shopify resends the same order after you switch test mode off, it goes out for real.

Things you'll see in `npx wrangler tail`:

| Log line | Meaning |
|---|---|
| `webhook enqueued` | The webhook arrived and passed the signature check. |
| `delivered` | A target accepted the event. |
| `skipped, no consent` | The visitor said no to that target's consent category. |
| `target disabled, missing config` | Lists the variables a target still needs. |
| `webhook rejected, bad hmac` | `SHOPIFY_WEBHOOK_SECRET` doesn't match Shopify's signing secret. |

To check the pixel on its own, set `DEBUG = true` at the top of the pixel code and start a checkout. The browser console shows `[ssa-pixel] POST /collect` and `/collect responded 204`. Set it back to `false` afterwards.

## Pixel privacy settings

The README recommends Permission **Required** with only **Analytics** ticked. Here's what the other choices do:

- **Required, with Marketing ticked too:** stricter. Shopify skips visitors who accepted analytics but not marketing, so GA4 loses their session link.
- **Not required:** the pixel runs for everyone, and the worker still checks consent before every send. But the pixel then reads cookies before the visitor has made a choice, which is a gray area under GDPR. Only pick it if your legal setup allows that.

**Data sale** defaults to "Data collected qualifies as data sale", which stops the pixel for visitors who opted out of the sale of their data. Meta and Awin receive customer details, so keep the default if you use them.

## Several stores

One worker can serve many stores. Put each store's settings in a `STORES` secret, as JSON keyed by its `*.myshopify.com` domain. The keys use the same variable names as above, and anything a store leaves out falls back to the worker's own variables.

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

Each store signs its webhooks with its own secret, so each entry needs its own `SHOPIFY_WEBHOOK_SECRET`. Target variables, `SEND_TEST_ORDERS` and `ORDER_SOURCES` can all be set per store. Every store's pixel uses the same `WORKER_URL`.

The worker accepts the shops listed in `STORES` plus any in `SHOP_DOMAINS`, and rejects the rest. A shop that's only in `SHOP_DOMAINS` uses the worker's own variables.

## Rate limit

`/collect` allows 60 requests a minute per IP, set by the `COLLECT_LIMITER` binding in `wrangler.jsonc` rather than a variable. See [Limits and caveats](limits.md).
