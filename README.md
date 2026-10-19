# Server Side Analytics Worker for Shopify

Send your Shopify purchases and refunds to GA4, server-side GTM, Meta and Awin from a Cloudflare Worker you host yourself. Orders come straight from Shopify's webhooks so every one gets counted, ad blockers or not. Each destination (a "target") lives in its own file and adding a new one is fairly simple and easy.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/adrianocr/ssa-worker-shopify)

## Why server-side

A browser pixel on the order status page will miss orders because ad blockers drop it, consent banners race it, and Shop Pay checkouts run on a domain where your `_ga` cookie doesn't exist. So the revenue in Shopify never quite matches the revenue in GA4 or Meta and you can't tell by how much.

Shopify's webhooks don't have that problem. Shopify sends a signed one for every order and every refund. Then the worker takes it from there.

The one thing a server can't see is the visitor's browser and attribution needs the `_ga` cookie, `_fbp`, `_fbc`, and click ids like `fbclid` and `awc`. So a small Shopify custom pixel picks those up at checkout and hands them off to the worker. The pixel never reports purchases itself. If it gets blocked the purchase still goes out, just with less attribution.

## How it works

```
 Browser                          Shopify                    Your Worker
 -------                          -------                    -----------
 custom pixel  ------------------------------------------->  POST /collect
 (cookies, click ids, consent)                               saves identity

                       order placed
                                  orders/create  --------->  POST /webhooks/shopify
                                  refunds/create             checks the signature
                                                             queues it for 2 minutes

                                                             Queue consumer
                                                             joins order + identity
                                                             checks consent per target
                                                               +--> GA4
                                                               +--> server-side GTM
                                                               +--> Meta
                                                               +--> Awin
```

The two minute wait gives the pixel time to report in before the worker looks up who placed the order. The two are joined on Shopify's checkout token. If one target fails, only that target is retried. [How it works](docs/how-it-works.md) goes deeper.

## Targets

| Target | Purchases | Refunds | Needs consent for | Setup guide |
|---|---|---|---|---|
| GA4 | yes | yes | analytics | [ga4.md](docs/targets/ga4.md) |
| Server-side GTM | yes | yes | analytics | [sgtm.md](docs/targets/sgtm.md) |
| Meta Conversions API | yes | no | marketing | [meta.md](docs/targets/meta.md) |
| Awin | yes | no | marketing | [awin.md](docs/targets/awin.md) |

You only set up the ones you use. A target without credentials switches itself off and logs what it's missing. TikTok isn't built yet but [there are notes](docs/targets/tiktok.md) if you'd like to write it.

## Setup

There are five steps that should that should be followed in order. Shopify needs the worker's URL, and the worker needs Shopify's signing secret.

### 1. Deploy the worker

The quickest way is the **Deploy to Cloudflare** button above. It forks the repo, creates the database and deploys. When it asks for `SHOPIFY_WEBHOOK_SECRET`, type any placeholder for now. You'll get the real one in step 2.

Or from the command line:

```bash
git clone https://github.com/adrianocr/ssa-worker-shopify
cd ssa-worker-shopify
npm ci
npx wrangler login
npm run setup     # creates the queue (only needed once)
npm run deploy
```

If the button's deploy fails on the queue, run `npm run setup` from a clone and deploy again. Wrangler creates the database by itself, but not the queue.

Wrangler prints your worker's URL, something like `https://ssa-worker-shopify.your-subdomain.workers.dev`. Keep it handy.

### 2. Add the Shopify webhooks

In the Shopify admin, go to **Settings > Notifications > Webhooks** and click **Create webhook** twice:

| Event | Format | URL | API version |
|---|---|---|---|
| Order creation | JSON | `https://<your-worker>/webhooks/shopify` | the one marked Latest |
| Refund create | JSON | `https://<your-worker>/webhooks/shopify` | the one marked Latest |

The same page shows your signing secret, in a line that starts "Your webhooks will be signed with". Copy it and give it to the worker:

```bash
npx wrangler secret put SHOPIFY_WEBHOOK_SECRET
```

Do this right away. Until the secret matches, every webhook is rejected, and Shopify deletes webhooks that keep failing.

Then tell the worker which store it serves, so it ignores everyone else:

```bash
npx wrangler secret put SHOP_DOMAINS   # e.g. x7y8z9-ab.myshopify.com
```

Use your store's permanent `.myshopify.com` domain, which can differ from the name in your admin URL. The easiest way to find it: click **Send test** in the webhook's menu, and `npx wrangler tail` shows the domain Shopify sends.

### 3. Add the custom pixel

1. Go to **Settings > Customer events > Add custom pixel** and give it a name.
2. Paste in the whole of [`pixel/custom-pixel.js`](pixel/custom-pixel.js).
3. Set `WORKER_URL` at the top to your worker's URL, without a trailing slash.
4. Under **Customer privacy**, set Permission to **Required** and tick only **Analytics**. Shopify ticks Marketing too by default, so untick it. Leave **Data sale** as it is.
5. Save, then click **Connect**.

With that setting, the pixel only runs for visitors who accept analytics. The worker then checks each visitor's full consent per target, so someone who said yes to analytics but no to marketing still shows up in GA4, but not in Meta or Awin. [Consent](#consent) below has the details.

If your theme or Additional scripts already send purchases to the same destinations, remove them, or you'll count every order twice.

### 4. Add your target credentials

Each target's guide walks you through finding its keys: [GA4](docs/targets/ga4.md), [server-side GTM](docs/targets/sgtm.md), [Meta](docs/targets/meta.md), [Awin](docs/targets/awin.md). Set each one as a secret. For GA4, that's:

```bash
npx wrangler secret put GA4_MEASUREMENT_ID
npx wrangler secret put GA4_API_SECRET
```

GA4 also needs Google's tag on your storefront, because only a browser tag sets the `_ga` cookie that ties a sale to a visitor and a traffic source. The Google & YouTube app adds one, or you can paste Google's gtag snippet into `layout/theme.liquid`. Just make sure that tag doesn't send purchases too.

### 5. Check it works

Open the worker's logs and place an order:

```bash
npx wrangler tail
```

You should see `webhook enqueued` right away, then `delivered` for each target about two minutes later.

Orders paid with Shopify's Bogus Gateway or a payment provider's test mode are test orders, and the worker skips them by default. To test with one, set `SEND_TEST_ORDERS` to `true`, and delete it again when you're done. Each target also has its own safe test mode, such as `GA4_DEBUG` which validates GA4 events without recording them. See [Configuration](docs/configuration.md#testing-safely).

## Consent

Shopify tracks four consent categories: 

1. analytics 
2. marketing
3. preferences
4. sale of data. 

GA4 and server-side GTM need analytics consent. Meta and Awin need marketing consent, since they receive customer details.

When the pixel reports a visitor's choice, the worker follows it. When there's no choice to follow, because the pixel was blocked or never ran, analytics targets still send and marketing targets don't. That keeps your GA4 revenue totals right without sending anyone's personal details to an ad platform without a yes.

| What the worker knows | Analytics targets | Marketing targets |
|---|---|---|
| Visitor said yes | send | send |
| Visitor said no | skip | skip |
| Nothing | send, anonymously | skip |

## Customizing

All configuration happens in environment variables and in one file, [`src/config.ts`](src/config.ts), which lists the targets and maps variables to them. You should never edit anything under `src/targets/`.

- **[Configuration](docs/configuration.md):** every variable, running several stores from one worker, and test modes.
- **[Limits and caveats](docs/limits.md):** what the worker skips, Cloudflare's free plan quotas, and retries.
- **[Writing a target](docs/writing-a-target.md):** adding a new destination takes one file, plus one line in `src/config.ts`.

## Contributing

Bug reports, fixes, changes, and new targets are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers local development and tests. Please report security issues privately, as described in [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
