# Awin

Sends orders to Awin's Conversion API (server-to-server) so affiliate sales get tracked without the browser tag. Consent category: marketing. There are no refunds from this target.

## Variables

| Variable | Required | Value |
|---|---|---|
| `AWIN_ADVERTISER_ID` | yes | Your advertiser id |
| `AWIN_API_KEY` | yes | Conversion API key |
| `AWIN_COMMISSION_GROUP` | no | Commission group code, default `DEFAULT` |
| `AWIN_TEST` | no | `true` sends orders as test conversions |
| `AWIN_COOKIE_DAYS` | no | Days an `awc` click counts, default `30` |

I couldn't confirm the steps below from Awin's public docs. Awin's page says orders need an API key in the `x-api-key` header and doesn't say how to get one. Check this in your account.

## Advertiser id

The numeric id of your advertiser account. It's shown in the Awin interface next to your account name, and it's part of your tracking setup. Check this in your account.

## API key

A third-party integration guide describes creating it under Account > API Credentials in the Awin interface, then generating a key. Check this in your account, and ask your Awin account manager if you don't have access to that page. Keep the key secret.

## Commission group

Commission groups are set up in Commission Management on the Awin platform. The code you send has to exist there. Awin's docs say codes may contain uppercase letters, digits, underscores, periods and hyphens, and that the static code `DEFAULT` is the one to use for orders that have no specific mapping. Leave `AWIN_COMMISSION_GROUP` unset to use `DEFAULT`. Otherwise set it to the code your program uses.

## What gets sent

POST `https://api.awin.com/s2s/advertiser/<advertiser id>/orders` with an `x-api-key` header.

```json
{
  "orders": [
    {
      "orderReference": "1001",
      "amount": 84.0,
      "channel": "aw",
      "currency": "USD",
      "awc": "<click id>",
      "commissionGroups": [{ "code": "DEFAULT", "amount": 84.0 }]
    }
  ]
}
```

- `orderReference` is the Shopify order name without the leading `#`, cut to 50 characters.
- `amount` is the order total minus tax and shipping, to two decimals, since commission is paid on the net. It's the same value in the commission group.
- `awc` is the Awin click id the pixel stored when the visitor landed with `?awc=...` in the URL.
- `channel` is `aw` when the `awc` is the most recent paid click the pixel saw, and `other` when a later click id (`gclid`, `fbclid`, `msclkid` and the rest) came after it. Awin's [channel parameter](https://help.awin.com/developers/docs/channel-parameter) page asks for the channel "deemed as the last-click referrer", with `aw` for Awin. It gives `display`, `ppc` and `email` as examples for other channels and doesn't define `other`. The worker only knows another click came later, not what kind of channel it was, so it sends `other`. Ask your account manager how your program deduplicates on it.
- Click ids that were older than `AWIN_COOKIE_DAYS` (default 30) when the order was placed don't count for `channel`, and an `awc` older than that is treated as missing (`skipped: awc older than 30 days`). The window is measured from the order's creation time, so a send delayed by retries doesn't lose a click that counted at checkout. Set it to your program's cookie length.

**Orders without an `awc` are skipped.** Awin needs it (or a publisher id and click time) to credit a publisher, and this target only supports `awc`. The skip is logged at debug level only (`skipped: no awc click id`), because most of your orders won't come from Awin. A skipped order isn't marked delivered.

If your Awin program also tracks with a browser tag, the same order may be reported twice. I don't know how Awin deduplicates the two. Ask your account manager before going live.

## Test mode

Awin's docs describe an `isTest` field: when it's true the transaction isn't tracked. Set `AWIN_TEST` to `true` and every order goes out with `isTest: true`. Any other value, or no value, leaves test mode off.

```bash
npx wrangler secret put AWIN_TEST   # true
```

Remove it once you've seen the request succeed in `npx wrangler tail` (`awin: purchase sent`):

```bash
npx wrangler secret delete AWIN_TEST
```

Test sends aren't recorded as delivered (the log says `sent, not recorded (debug or test mode)`), so a test doesn't block a later real send of the same order.

## Why no refunds

Awin's order endpoint is for creating conversions. The worker doesn't call anything to reverse one, so refunds are skipped. Handle reversals in the Awin interface.
