# Meta Conversions API

Sends `Purchase` events to a Meta dataset (pixel) through the Conversions API. Consent category: marketing. Meta has no refund event, so refunds aren't sent.

## Variables

| Variable | Required | Value |
|---|---|---|
| `META_PIXEL_ID` | yes | Dataset (pixel) id |
| `META_ACCESS_TOKEN` | yes | Conversions API access token |
| `META_TEST_EVENT_CODE` | no | Code from the Test events tab |
| `META_API_VERSION` | no | Graph API version, default `v25.0` |
| `META_CONTENT_ID` | no | `variant_id` (default), `sku` or `product_id` |

## Dataset id

1. Open Events Manager.
2. Under Data sources, pick the dataset (pixel) your store uses in the browser.
3. The id is shown under the dataset name and on its Settings tab.

Use the same dataset as your browser pixel. If that pixel also reports purchases, Meta can only deduplicate the two when the browser event carries the same event id (the Shopify order id). Check this in your account.

## Access token

From Meta's [get started guide](https://developers.facebook.com/docs/marketing-api/conversions-api/get-started):

1. Events Manager > pick the dataset.
2. Open the Settings tab.
3. Find the Conversions API section.
4. Under Set up manually, click Generate access token and follow the prompts.

The link only shows for people with developer access on the business. If you don't see it, ask whoever owns the business account to do this step. Treat the token like a password.

## Test event code

1. Events Manager > the dataset > Test events tab.
2. The code is shown there, for example `TEST12345`. Check this in your account, since Meta moves things around.
3. Set it as `META_TEST_EVENT_CODE`. The worker adds it to every request.

Events sent with a test code still reach Events Manager as real events and are used for ads. The code makes them visible in the Test events tab, nothing more. Remove it when you've checked the setup:

```bash
npx wrangler secret delete META_TEST_EVENT_CODE
```

Test sends aren't recorded as delivered. The log line is `sent, not recorded (debug or test mode)`. Once you remove the code, orders are sent and recorded as usual, including a repeat of a tested order's webhook.

## What gets sent

POST `https://graph.facebook.com/v25.0/<dataset id>/events`. The Graph API version is `v25.0` by default. To change it, set `META_API_VERSION` (for example `v26.0`).

- `event_name` is `Purchase`, `action_source` is `website`, `event_id` is the order id, `event_time` is the order's creation time.
- `custom_data` has `currency`, `value`, `order_id`, `content_type: "product"`, `content_ids`, `contents` and `num_items`. `num_items` is the order's full quantity, even when the item list was cut to fit a queue message.
- `content_ids` and `contents[].id` are the Shopify variant id by default. Catalogs that Shopify's Facebook & Instagram sales channel syncs use variant ids, so this is what matches your catalog. If your catalog uses SKUs or product ids, set `META_CONTENT_ID` to `sku` or `product_id`. When a line has no value for the chosen field, the worker tries variant id, then SKU, then product id, then the line id. The value is trimmed and lowercased, so `SKU` works. An unknown value logs `meta: unknown META_CONTENT_ID, using variant_id` once and uses `variant_id`.
- `user_data` has SHA-256 hashes of email, phone, first and last name, city, state, zip, country and customer id, each normalized first as Meta requires. `client_ip_address`, `client_user_agent`, `fbp` and `fbc` are sent as they are, because Meta says never to hash them.
- `fbp` and `fbc` come from the `_fbp` and `_fbc` cookies. If there's no `_fbc` but the pixel saw an `fbclid`, the worker builds `fb.1.<time>.<fbclid>`.
- `event_source_url` is the checkout URL from the pixel. Without one it's the order's landing page from Shopify (`landing_site`, made absolute on your `*.myshopify.com` domain), and without that, `https://<shop>.myshopify.com/`.

Meta rejects events with an `event_time` older than 7 days. The worker logs a warning and skips an order older than that, and doesn't mark it delivered. The consumer's debug line is `skipped: order older than 7 days`.

If the visitor said no to marketing, nothing is sent. If the worker has no consent information at all, nothing is sent either.

## Check it

Set a test code, place a test order, and wait for the delay (two minutes by default). The event appears in the Test events tab. In `npx wrangler tail` you'll see `meta: purchase sent`.
