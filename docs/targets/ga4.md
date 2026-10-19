# GA4

Sends `purchase` and `refund` events to GA4 through the Measurement Protocol. Consent category: analytics.

## Variables

| Variable | Required | Value |
|---|---|---|
| `GA4_MEASUREMENT_ID` | yes | `G-XXXXXXXXXX` |
| `GA4_API_SECRET` | yes | Measurement Protocol API secret |
| `GA4_DEBUG` | no | `true` to validate without recording |

## Get the measurement id

1. In GA4 open Admin (the gear icon, bottom left).
2. Under Data collection and modification, click Data streams.
3. Click your web stream.
4. The measurement id is at the top right of the stream details, starting with `G-`.

Use the stream your storefront already reports to. A different stream puts the purchase in a different data stream than the visit that led to it.

## Create the API secret

This matches Google's [Measurement Protocol docs](https://developers.google.com/analytics/devguides/collection/protocol/ga4/sending-events).

1. Admin > Data collection and modification > Data streams.
2. Click the web stream.
3. Click Measurement Protocol API secrets.
4. Click Create, enter a nickname such as `ssa-worker`, then Create.
5. Copy the secret value.

Set both on the worker:

```bash
npx wrangler secret put GA4_MEASUREMENT_ID
npx wrangler secret put GA4_API_SECRET
```

## What gets sent

POST `https://www.google-analytics.com/mp/collect?measurement_id=...&api_secret=...`

- `client_id` comes from the `_ga` cookie the pixel collected (`GA1.1.123.456` becomes `123.456`). Shopify's own client id isn't a valid GA4 client id, so it isn't used. Without a `_ga` cookie the worker uses the order id. The sale still counts, but as a new user.
- `session_id` comes from the `_ga_<id>` cookie for your measurement id, when the pixel collected it.
- `purchase` has `transaction_id` (the Shopify order id), `value`, `currency`, `tax`, `shipping` and `items`. `value` is the order total minus tax and shipping, because GA4's `value` excludes both. `tax` and `shipping` are sent as their own parameters.
- Each item's `price` is the discounted unit price and `discount` is the discount per unit (the line's discount divided by its quantity, to two decimals). Google's [Measurement Protocol reference](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference/events) says: "If a discount applies to the item, set price to the discounted unit price and specify the unit price discount in the discount parameter."
- `refund` uses the same `transaction_id`, so GA4 can match it to the purchase. Its `value` is the refunded line subtotals, before tax like the purchase's, summed from every line even when the item list was cut to fit a queue message. A refund with no lines (shipping only, or an amount entered by hand) uses the money returned instead. Refund items carry `price`, the line's refunded amount divided by its quantity. `items` is left out when there are none.
- Amounts are in the shop's currency (Shopify's `shop_money`), so a purchase and its refund are in the same currency even when the buyer paid in another one. The exception is a refund with no lines on such an order: the money returned is only known in the buyer's currency, so it's sent with that currency.
- `timestamp_micros` is the order's creation time for a purchase and the refund's for a refund, when that's within the last 72 hours. The Measurement Protocol doesn't accept older times, so then it's left out and GA4 uses the time it received the event. A time up to 5 minutes in the future (clock skew) is sent as the current time; one further ahead is left out.
- `consent` carries `ad_user_data` and `ad_personalization`: `GRANTED` when the visitor accepted marketing, `DENIED` when they declined, and no `consent` object when the pixel never reported a choice.
- Orders Shopify flags as test, and orders whose `source_name` isn't in `ORDER_SOURCES` (default `web`), aren't sent. See [Configuration](../configuration.md).

The worker always uses the global `www.google-analytics.com` endpoint.

## Check it

Set `GA4_DEBUG=true`, place a test order, and run `npx wrangler tail`. The worker sends to `/debug/mp/collect` and logs `ga4 debug validation` with Google's `validationMessages`. An empty list means the payload is valid. Debug events aren't recorded in GA4.

Debug sends aren't recorded as delivered. The log line is `sent, not recorded (debug or test mode)`. Turning debug off doesn't need any cleanup: the next order goes to the live endpoint, and so would a repeat of the tested order's webhook.

With debug off, the live endpoint answers 204 and says nothing about whether the payload was good. Look in GA4 under Admin > DebugView or Reports > Realtime. Reports can take hours to fill in. Check this in your property if your numbers look off.
