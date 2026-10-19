# Server-side GTM

Sends the same GA4-shaped `purchase` and `refund` events as the [GA4 target](ga4.md), but to your own server-side Google Tag Manager container instead of Google. Consent category: analytics.

Use it when you want the event to pass through your own tagging server, so you can fan it out with GTM tags. You can run it alongside the GA4 target, but then GA4 may count the purchase twice. Pick one of them for GA4 itself.

## Variables

| Variable | Required | Value |
|---|---|---|
| `SGTM_URL` | yes | Full collect URL, for example `https://sgtm.example.com/mp/collect` |
| `SGTM_MEASUREMENT_ID` | no | Added as `measurement_id`. Also used to find the GA4 session cookie. |
| `SGTM_API_SECRET` | no | Added as `api_secret` |

## Set up the container

You need a server-side GTM container that's already deployed and reachable on a URL (your own domain is best).

1. In the server container, go to Clients > New.
2. Choose the Measurement Protocol client type.
3. Set the Activation Path to `/mp/collect`. The path in `SGTM_URL` has to match it.
4. Save, then publish the container.

Google's page on this is [Send data to server-side tagging](https://developers.google.com/tag-platform/tag-manager/server-side/send-data). It doesn't name a default path, so `/mp/collect` here is the convention that mirrors GA4's own endpoint, not a Google default.

Then add a GA4 tag in the container that triggers on the `purchase` and `refund` events from this client.

## Credentials

- `SGTM_URL`: your tagging server's URL plus the activation path.
- `SGTM_MEASUREMENT_ID`: the GA4 measurement id (`G-...`). Set it if you want `session_id` on the event.
- `SGTM_API_SECRET`: whether the Measurement Protocol client requires an `api_secret` isn't something I could confirm from Google's page. Check this in your container's client settings. If the client doesn't require one, leave it unset.

```bash
npx wrangler secret put SGTM_URL
```

## What gets sent

The payload is identical to the GA4 target: `client_id` from `_ga` (order id as a fallback), `session_id` when available, `timestamp_micros` within 72 hours, `consent`, `transaction_id`, `value` (without tax and shipping), `currency`, `tax`, `shipping` and `items`. See [ga4.md](ga4.md).

`consent` has `ad_user_data` and `ad_personalization` set to `GRANTED` or `DENIED` from the visitor's marketing choice, and is left out when the worker doesn't know it. The sGTM target only checks analytics consent before sending, so your container must honor these two signals itself: tags that send to ad platforms (Google Ads, Floodlight, anything that uses the data for advertising) shouldn't fire on `DENIED`. Check how your container's tags read consent from the Measurement Protocol client.

## Check it

Open the container's Preview mode while you place a test order, and look for a `purchase` request from the Measurement Protocol client. `npx wrangler tail` shows `delivered` when the worker got a 2xx, and a `send failed` line with the status when it didn't.
