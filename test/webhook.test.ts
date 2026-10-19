import { describe, expect, it } from "vitest";
import { MAX_WEBHOOK_BYTES } from "../src/core/worker";
import { call, configWith, fakeTarget, makeEnv, orderFixture, refundFixture, sign, uniqueShop, webhook } from "./helpers";

const config = configWith([fakeTarget("a")]);

describe("POST /webhooks/shopify", () => {
  it("rejects a bad HMAC with 401", async () => {
    const { env, sent } = makeEnv();
    const res = await webhook(config, env, { shop: uniqueShop(), topic: "orders/create", body: orderFixture, hmac: await sign("other body") });
    expect(res.status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it("rejects a missing HMAC with 401", async () => {
    const { env, sent } = makeEnv();
    const res = await webhook(config, env, { shop: uniqueShop(), topic: "orders/create", body: orderFixture, hmac: null });
    expect(res.status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it("rejects garbage in the HMAC header with 401", async () => {
    const { env } = makeEnv();
    const res = await webhook(config, env, { shop: uniqueShop(), topic: "orders/create", body: orderFixture, hmac: "%%%not base64" });
    expect(res.status).toBe(401);
  });

  it("rejects a signature made with another secret", async () => {
    const { env } = makeEnv();
    const raw = JSON.stringify(orderFixture);
    const res = await webhook(config, env, { shop: uniqueShop(), topic: "orders/create", body: orderFixture, hmac: await sign(raw, "wrong") });
    expect(res.status).toBe(401);
  });

  it("rejects a shop outside SHOP_DOMAINS with 401 even when the HMAC is valid", async () => {
    const allowed = uniqueShop();
    const { env, sent } = makeEnv({ SHOP_DOMAINS: `${allowed}, other.myshopify.com` });
    const res = await webhook(config, env, { shop: uniqueShop(), topic: "orders/create", body: orderFixture });
    expect(res.status).toBe(401);
    expect(sent).toHaveLength(0);

    const ok = await webhook(config, env, { shop: allowed, topic: "orders/create", body: orderFixture });
    expect(ok.status).toBe(200);
  });

  it("enqueues one purchase with delaySeconds = PIXEL_WAIT_SECONDS", async () => {
    const shop = uniqueShop();
    const { env, sent } = makeEnv({ PIXEL_WAIT_SECONDS: "45" });
    const res = await webhook(config, env, { shop, topic: "orders/create", body: orderFixture });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.delaySeconds).toBe(45);
    expect(sent[0]!.body).toMatchObject({ kind: "purchase", shop, attempt: 1, order: { id: "5820000001001", shop } });
    expect(sent[0]!.body.targets).toBeUndefined();
  });

  it("defaults the delay to 120 seconds", async () => {
    const { env, sent } = makeEnv({ PIXEL_WAIT_SECONDS: undefined });
    await webhook(config, env, { shop: uniqueShop(), topic: "orders/create", body: orderFixture });
    expect(sent[0]!.delaySeconds).toBe(120);
  });

  it("enqueues refunds/create as a refund", async () => {
    const { env, sent } = makeEnv();
    const res = await webhook(config, env, { shop: uniqueShop(), topic: "refunds/create", body: refundFixture });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ kind: "refund", refund: { id: "9330000001001", orderId: "5820000001001" } });
  });

  it("returns 200 and enqueues nothing for an unhandled topic", async () => {
    const { env, sent } = makeEnv();
    const res = await webhook(config, env, { shop: uniqueShop(), topic: "orders/updated", body: orderFixture });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0);
  });

  it("returns 400 for a signed payload without an id", async () => {
    const { env, sent } = makeEnv();
    const res = await webhook(config, env, { shop: uniqueShop(), topic: "orders/create", body: { name: "#1" } });
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("verifies a body with non-ASCII characters and keeps them intact", async () => {
    const shop = uniqueShop();
    const { env, sent } = makeEnv();
    const body = { ...orderFixture, name: "#Caf\u00e9-1001", line_items: [{ ...orderFixture.line_items[0], title: "Cr\u00e8me br\u00fbl\u00e9e \u65e5\u672c" }] };
    const res = await webhook(config, env, { shop, topic: "orders/create", body });
    expect(res.status).toBe(200);
    if (sent[0]!.body.kind !== "purchase") throw new Error("expected a purchase");
    expect(sent[0]!.body.order.name).toBe("#Caf\u00e9-1001");
    expect(sent[0]!.body.order.lines[0]!.title).toBe("Cr\u00e8me br\u00fbl\u00e9e \u65e5\u672c");
  });

  it("computes the HMAC over the raw bytes, not a decoded string", async () => {
    // A leading BOM and an invalid UTF-8 byte both change when decoded and re-encoded.
    const json = new TextEncoder().encode(JSON.stringify({ ...orderFixture, note: "x#y" }));
    const marker = json.findIndex((b, i) => b === 0x23 && json[i - 1] === 0x78 && json[i + 1] === 0x79);
    json[marker] = 0xff;
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...json]);
    const { env, sent } = makeEnv();
    const res = await webhook(config, env, { shop: uniqueShop(), topic: "orders/create", body: bytes });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  describe("body cap", () => {
    function paddedOrder(size: number): Uint8Array {
      const base = JSON.stringify({ ...orderFixture, note: "" });
      const json = base.replace('"note":""', `"note":"${"x".repeat(size - base.length)}"`);
      const bytes = new TextEncoder().encode(json);
      expect(bytes.byteLength).toBe(size);
      return bytes;
    }

    it("accepts a signed body of exactly 1 MB", async () => {
      const { env, sent } = makeEnv();
      const res = await webhook(config, env, { shop: uniqueShop(), topic: "orders/create", body: paddedOrder(MAX_WEBHOOK_BYTES) });
      expect(res.status).toBe(200);
      expect(sent).toHaveLength(1);
    });

    it("answers 413 for a correctly signed body over 1 MB, before HMAC", async () => {
      const { env, sent } = makeEnv();
      const res = await webhook(config, env, { shop: uniqueShop(), topic: "orders/create", body: paddedOrder(MAX_WEBHOOK_BYTES + 1) });
      expect(res.status).toBe(413);
      expect(sent).toHaveLength(0);
      const unsigned = await webhook(config, env, { shop: uniqueShop(), topic: "orders/create", body: paddedOrder(MAX_WEBHOOK_BYTES + 1), hmac: null });
      expect(unsigned.status).toBe(413);
    });

    it("aborts a chunked body with no Content-Length once it passes 1 MB", async () => {
      const { env, sent } = makeEnv();
      let pulls = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(64 * 1024).fill(0x20));
        },
      });
      const request = new Request("https://worker.test/webhooks/shopify", {
        method: "POST",
        headers: { "X-Shopify-Topic": "orders/create", "X-Shopify-Shop-Domain": uniqueShop(), "X-Shopify-Hmac-Sha256": "AAAA" },
        body: stream,
      });
      expect(request.headers.get("Content-Length")).toBeNull();
      const res = await call(config, env, request);
      expect(res.status).toBe(413);
      expect(pulls).toBeLessThan(20);
      expect(sent).toHaveLength(0);
    });
  });

  it("returns 500 when the enqueue fails so Shopify retries", async () => {
    const { env } = makeEnv({ failQueue: true });
    const res = await webhook(config, env, { shop: uniqueShop(), topic: "orders/create", body: orderFixture });
    expect(res.status).toBe(500);
  });
});
