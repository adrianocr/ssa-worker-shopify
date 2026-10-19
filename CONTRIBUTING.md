# Contributing

Bug reports, fixes and new targets are welcome.

## Setup

```bash
npm ci
cp .dev.vars.example .dev.vars   # fill in SHOPIFY_WEBHOOK_SECRET and any target you want to try
npm run dev
npm run typecheck
npm test
```

Both checks run in CI on every push and pull request. A PR needs both green.

Tests run with Vitest inside the Workers runtime. Targets are tested with a fake `fetch`, so no test hits a real API.

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

## What a good change looks like

- Small. One fix or one target per PR.
- Tested. Targets get a test file under `test/targets/` with a fake `fetch`. Nothing in the suite may call a real API.
- Honest about facts. If a target depends on an API behavior, link the vendor docs in the PR. If you couldn't confirm something, say so.
- No real data. No store domains, pixel ids, tokens or customer details in code, tests, fixtures or docs. Use `example-store.myshopify.com` and obvious fakes.

## New targets

Read [docs/writing-a-target.md](docs/writing-a-target.md). A target is one file in `src/targets/`, plus one import and one entry in `src/config.ts`. Add a page under `docs/targets/` that says where a user finds each credential, step by step. Open an issue first if the destination needs new browser identity from the pixel, because that changes `pixel/custom-pixel.js` and the data the worker stores.

## Style

- TypeScript, strict mode. `.editorconfig` sets the basics.
- Comments explain why, not what.
- Docs are plain and direct. No marketing words, no em dashes.

## Commits and PRs

Write the commit message in the imperative ("Fix refund lookup for orders without a checkout token"). Fill in the PR template. Say how you checked the change.

## Security

Don't open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
