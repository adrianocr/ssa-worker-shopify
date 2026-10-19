# Security

## Reporting a vulnerability

Report it privately through GitHub security advisories: open the repository's Security tab and choose "Report a vulnerability". Please don't open a public issue or pull request for it.

Include what you found, how to reproduce it, and what an attacker gains. You'll get a reply as soon as the maintainer can, and credit in the fix if you want it.

## Trust model

The worker has three entry points. Each one trusts something different.

**`POST /webhooks/shopify`.** Every request is verified with HMAC-SHA256 over the raw body, using the signing secret for the shop named in `X-Shopify-Shop-Domain`. The comparison is constant-time. An unknown shop or a bad signature gets a 401 and nothing else happens. Purchases and refunds only come from here, so nobody can inject an order without the secret.

**`POST /collect`.** This one is unauthenticated, on purpose. It's called from a visitor's browser, and there's nowhere to keep a secret there. What it can do is limited:

- It can only attach browser identity (cookies, click ids, consent flags, the checkout page URL) to a checkout token for a known shop.
- Identity reaches an order only through the checkout token in the signed `orders/create` webhook. Refunds follow the stored order row to that same token. An order id in the `/collect` body is ignored, because order ids are sequential and easy to guess.
- It never sends anything to a target. Only a verified webhook does.
- It can't create, change or refund an order.
- Bodies over 16 KB are rejected, unknown fields are dropped, and names and values are length-checked.
- Requests are rate limited per IP (60 a minute, the `COLLECT_LIMITER` binding in `wrangler.jsonc`). Over the limit the worker answers 429.
- Shops must be accepted by your config (`STORES`, `SHOP_DOMAINS`, or a webhook secret match). Set `SHOP_DOMAINS` on every deploy. Without it, any `*.myshopify.com` name is accepted here, which lets anyone write rows to your database.

The realistic abuse is someone who knows a checkout token posting wrong identity for it, which can misattribute that one order. Checkout tokens are long random strings, so guessing one isn't practical. The rate limit is counted per Cloudflare location and is approximate. If you still see junk in `/collect` traffic, add a Cloudflare WAF rule on that path.

**Queue and cron.** These are internal. Only your own worker enqueues messages and runs the cleanup.

## Data the worker stores

In D1: browser identity per checkout (cookies named `_ga`, `_ga_*`, `_fbp`, `_fbc`, `_ttp`, click ids, consent, IP address, user agent), plus order ids and checkout tokens from webhooks, and delivery records. Customer details from webhooks (email, name, address) are sent to targets and aren't written to D1. They do sit inside the queue message until it's processed. Identities with no matching order are deleted after 7 days. Everything else is deleted after 400 days.

## Secrets

Keep webhook secrets and target credentials in Wrangler secrets or `.dev.vars`, never in `wrangler.jsonc` or the repo. `.dev.vars` is git-ignored. If you think one leaked, rotate it at the source and update the secret.
