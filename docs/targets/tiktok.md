# TikTok Events API (not built)

**This target doesn't exist yet.** This page is a starting point for whoever writes it. Every fact below is unverified. It comes from third-party integration guides, not from TikTok's official developer docs, which I couldn't load. Confirm each point against TikTok's current Events API documentation before writing code.

## What the pixel already collects

The custom pixel already stores `ttclid` from landing URLs and reads the `_ttp` cookie. A TikTok target wouldn't need pixel changes. Both arrive in `identity`: `identity.clickIds.ttclid` and `identity.cookies._ttp`.

## Likely shape (unverified)

- Endpoint: `POST https://business-api.tiktok.com/open_api/v1.3/event/track/`
- Auth: an access token, sent in an `Access-Token` header. Generated in Events Manager under Settings > Events API > Generate access token.
- Pixel code: from Ads Manager.
- Event: a purchase-type event with `event_id` (the Shopify order id, as the other targets do), a timestamp, `value`, `currency` and line items.
- User fields: `ttclid` and `ttp` unhashed. Email, phone and external id SHA-256 hashed after normalizing.
- Page URL, IP and user agent from `identity`, like the Meta target.

## Open questions

- Header name, body field names and the exact event name.
- Whether TikTok deduplicates browser and server copies by `event_id`. One source says yes, another says no.
- Test event code support.
- Event age limit.
- Refunds: probably none, like Meta. Unknown.

## Consent

`marketing`. It sends hashed customer details to an ad platform.

## Writing it

Follow [../writing-a-target.md](../writing-a-target.md). Use `src/targets/meta.ts` as the closest example, since it hashes with `src/targets/hash.ts`. Open an issue with the "New target" template if you plan to take it, and link the official docs you used in the PR.
