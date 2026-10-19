import { env as workerEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { openStore } from "../src/core/store";
import { call, collect, configWith, fakeLimiter, makeEnv, uniqueShop } from "./helpers";

const config = configWith([]);

async function row(shop: string, token: string) {
  return workerEnv.DB.prepare("SELECT order_id, data FROM identities WHERE shop = ? AND checkout_token = ?")
    .bind(shop, token)
    .first<{ order_id: string | null; data: string }>();
}

describe("POST /collect", () => {
  it("stores identity with IP and User-Agent from the request", async () => {
    const shop = uniqueShop();
    const { env } = makeEnv();
    const res = await collect(
      config,
      env,
      {
        shop,
        checkoutToken: "tok-1",
        clientId: "shopify-client-1",
        cookies: { _ga: "GA1.1.111.222", _fbp: "fb.1.1700000000000.42" },
        clickIds: { gclid: { value: "g-1", at: 1_700_000_000_000 } },
        consent: { analytics: true, marketing: false, bogus: true },
        pageUrl: "https://example-store.myshopify.com/checkouts/cn/tok-1",
      },
      { "CF-Connecting-IP": "198.51.100.7", "User-Agent": "TestAgent/1.0" },
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const stored = (await (await openStore(workerEnv.DB)).getIdentity(shop, "tok-1"))!;
    expect(stored.identity).toMatchObject({
      shopifyClientId: "shopify-client-1",
      cookies: { _ga: "GA1.1.111.222", _fbp: "fb.1.1700000000000.42" },
      clickIds: { gclid: { value: "g-1", at: 1_700_000_000_000 } },
      consent: { analytics: true, marketing: false },
      ip: "198.51.100.7",
      userAgent: "TestAgent/1.0",
      pageUrl: "https://example-store.myshopify.com/checkouts/cn/tok-1",
    });
    expect(stored.identity.consent).not.toHaveProperty("bogus");
  });

  it("merges click ids on a second POST for the same checkout and never stores the pixel's order id", async () => {
    const shop = uniqueShop();
    const { env } = makeEnv();
    await collect(config, env, { shop, checkoutToken: "tok-2", clickIds: { gclid: { value: "g-1", at: 1000 } }, consent: { marketing: false } });
    const res = await collect(config, env, {
      shop,
      checkoutToken: "tok-2",
      orderId: "gid://shopify/Order/5820000001001",
      clickIds: { gclid: { value: "g-1", at: 5000 }, fbclid: "fb-1", awc: { value: "awc-9", at: 2000 } },
      consent: { marketing: true },
    });
    expect(res.status).toBe(204);

    const r = (await row(shop, "tok-2"))!;
    expect(r.order_id).toBeNull();
    const identity = JSON.parse(r.data);
    expect(identity.clickIds.gclid).toEqual({ value: "g-1", at: 1000 });
    expect(identity.clickIds.awc).toEqual({ value: "awc-9", at: 2000 });
    expect(identity.clickIds.fbclid.value).toBe("fb-1");
    expect(identity.consent).toEqual({ marketing: true });
  });

  it("accepts and ignores any orderId so older pixels don't get a 400", async () => {
    const { env } = makeEnv();
    const shop = uniqueShop();
    for (const orderId of ["gid://shopify/OrderIdentity/42", "gid://shopify/Order/abc", 7, { nested: true }, null]) {
      const res = await collect(config, env, { shop, checkoutToken: "tok-old-pixel", orderId });
      expect(res.status, JSON.stringify(orderId)).toBe(204);
    }
    expect((await row(shop, "tok-old-pixel"))!.order_id).toBeNull();
  });

  it("rejects oversized bodies with 413", async () => {
    const { env } = makeEnv();
    const body = JSON.stringify({ shop: uniqueShop(), checkoutToken: "t", pageUrl: "x".repeat(17 * 1024) });
    const res = await collect(config, env, body);
    expect(res.status).toBe(413);
  });

  it("aborts a chunked body with no Content-Length once it passes 16 KB", async () => {
    const { env } = makeEnv();
    let pulls = 0;
    // Never closes: a handler that buffered the whole body would hang here.
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1024).fill(0x20));
      },
    });
    const request = new Request("https://worker.test/collect", { method: "POST", headers: { "Content-Type": "text/plain" }, body: stream });
    expect(request.headers.get("Content-Length")).toBeNull();
    const res = await call(config, env, request);
    expect(res.status).toBe(413);
    expect(pulls).toBeLessThan(40);
  });

  it("rejects a Content-Length over 16 KB without reading the body", async () => {
    const { env } = makeEnv();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    }, { highWaterMark: 0 });
    const request = new Request("https://worker.test/collect", {
      method: "POST",
      headers: { "Content-Type": "text/plain", "Content-Length": String(16 * 1024 + 1) },
      body: stream,
    });
    const res = await call(config, env, request);
    expect(res.status).toBe(413);
    expect(pulls).toBe(0);
  });

  it("accepts a chunked body under 16 KB", async () => {
    const { env } = makeEnv();
    const shop = uniqueShop();
    const bytes = new TextEncoder().encode(JSON.stringify({ shop, checkoutToken: "tok-chunked" }));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 10));
        controller.enqueue(bytes.slice(10));
        controller.close();
      },
    });
    const res = await call(config, env, new Request("https://worker.test/collect", { method: "POST", body: stream }));
    expect(res.status).toBe(204);
    expect(await row(shop, "tok-chunked")).not.toBeNull();
  });

  it("rejects malformed bodies with 400", async () => {
    const { env } = makeEnv();
    const shop = uniqueShop();
    for (const body of [
      "{not json",
      "[]",
      JSON.stringify({ checkoutToken: "t" }),
      JSON.stringify({ shop: "not-a-shop.example.com", checkoutToken: "t" }),
      JSON.stringify({ shop }),
      JSON.stringify({ shop, checkoutToken: "t", cookies: "nope" }),
    ]) {
      const res = await collect(config, env, body);
      expect(res.status, body).toBe(400);
    }
  });

  it("checks the shop against the allowlist only, without building the merged config per hit", async () => {
    const shop = uniqueShop();
    const { env } = makeEnv({ SHOP_DOMAINS: shop });
    // shopVars copies every env value; this getter counts whether anything still does that per hit.
    let reads = 0;
    Object.defineProperty(env, "GA4_API_SECRET", {
      enumerable: true,
      get: () => {
        reads += 1;
        return "x";
      },
    });
    for (let i = 0; i < 5; i++) {
      expect((await collect(config, env, { shop, checkoutToken: `tok-memo-${i}` })).status).toBe(204);
    }
    expect((await collect(config, env, { shop: uniqueShop(), checkoutToken: "tok-memo-x" })).status).toBe(400);
    expect(reads).toBe(0);
  });

  it("rejects shops outside SHOP_DOMAINS", async () => {
    const { env } = makeEnv({ SHOP_DOMAINS: "only.myshopify.com" });
    const res = await collect(config, env, { shop: uniqueShop(), checkoutToken: "t" });
    expect(res.status).toBe(400);
  });

  describe("rate limit", () => {
    it("answers 429 when the limiter says no, keyed on CF-Connecting-IP", async () => {
      const { limiter, keys } = fakeLimiter(false);
      const { env } = makeEnv({ COLLECT_LIMITER: limiter });
      const shop = uniqueShop();
      const res = await collect(config, env, { shop, checkoutToken: "tok-limited" }, { "CF-Connecting-IP": "198.51.100.9" });
      expect(res.status).toBe(429);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(keys).toEqual(["198.51.100.9"]);
      expect(await row(shop, "tok-limited")).toBeNull();
    });

    it("stores the identity when the limiter allows it", async () => {
      const { limiter, keys } = fakeLimiter(true);
      const { env } = makeEnv({ COLLECT_LIMITER: limiter });
      const shop = uniqueShop();
      const res = await collect(config, env, { shop, checkoutToken: "tok-allowed" }, { "CF-Connecting-IP": "198.51.100.10" });
      expect(res.status).toBe(204);
      expect(keys).toEqual(["198.51.100.10"]);
      expect(await row(shop, "tok-allowed")).not.toBeNull();
    });

    it("skips the check without the binding or without an IP, and fails open on a limiter error", async () => {
      const { env } = makeEnv();
      expect((await collect(config, env, { shop: uniqueShop(), checkoutToken: "t" }, { "CF-Connecting-IP": "198.51.100.11" })).status).toBe(204);

      const noIp = fakeLimiter(false);
      const noIpEnv = makeEnv({ COLLECT_LIMITER: noIp.limiter }).env;
      expect((await collect(config, noIpEnv, { shop: uniqueShop(), checkoutToken: "t" })).status).toBe(204);
      expect(noIp.keys).toEqual([]);

      const broken = fakeLimiter(() => {
        throw new Error("limiter down");
      });
      const brokenEnv = makeEnv({ COLLECT_LIMITER: broken.limiter }).env;
      expect((await collect(config, brokenEnv, { shop: uniqueShop(), checkoutToken: "t" }, { "CF-Connecting-IP": "198.51.100.12" })).status).toBe(204);
    });

    it("doesn't count CORS preflights", async () => {
      const { limiter, keys } = fakeLimiter(false);
      const { env } = makeEnv({ COLLECT_LIMITER: limiter });
      const res = await call(
        config,
        env,
        new Request("https://worker.test/collect", {
          method: "OPTIONS",
          headers: { Origin: "https://example-store.myshopify.com", "Access-Control-Request-Method": "POST", "CF-Connecting-IP": "198.51.100.13" },
        }),
      );
      expect(res.status).toBe(204);
      expect(keys).toEqual([]);
    });
  });

  it("answers the CORS preflight", async () => {
    const { env } = makeEnv();
    const res = await call(
      config,
      env,
      new Request("https://worker.test/collect", {
        method: "OPTIONS",
        headers: { Origin: "https://example-store.myshopify.com", "Access-Control-Request-Method": "POST" },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });
});
