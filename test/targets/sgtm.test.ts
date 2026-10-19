import { describe, expect, it } from "vitest";
import { TargetError } from "../../src/core/target";
import type { Identity, TargetContext } from "../../src/core/types";
import { createLogger } from "../../src/core/log";
import { sgtm } from "../../src/targets/sgtm";
import { fixtureOrder, fixtureRefund, uniqueShop } from "../helpers";

function mockCtx(status = 204) {
  const seen: { url: string; body: any }[] = [];
  const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(null, { status });
  }) as typeof fetch;
  const ctx: TargetContext = { shop: "s.myshopify.com", log: createLogger(), fetch: fetchMock };
  return { ctx, seen };
}

const id: Identity = {
  cookies: { _ga: "GA1.1.55.66", _ga_ABC123: "GS2.1.s1700000005$o1" },
  clickIds: {},
  consent: {},
  collectedAt: 0,
};

describe("sgtm target", () => {
  it("is disabled without a url", () => {
    expect(sgtm({}).missing).toEqual(["url"]);
  });

  it("posts the ga4 payload to the url without query params when none are given", async () => {
    const { ctx, seen } = mockCtx();
    const order = fixtureOrder(uniqueShop());
    await sgtm({ url: "https://sgtm.example.com/mp/collect" }).purchase(order, id, ctx);
    expect(seen[0]!.url).toBe("https://sgtm.example.com/mp/collect");
    expect(seen[0]!.body.client_id).toBe("55.66");
    expect(seen[0]!.body.events[0].name).toBe("purchase");
    expect(seen[0]!.body.events[0].params.transaction_id).toBe(order.id);
    expect(seen[0]!.body.events[0].params).not.toHaveProperty("session_id");
  });

  it("appends measurement_id and api_secret and keeps the existing query", async () => {
    const { ctx, seen } = mockCtx();
    await sgtm({
      url: "https://sgtm.example.com/mp/collect?foo=bar",
      measurementId: "G-ABC123",
      apiSecret: "s3cret",
    }).purchase(fixtureOrder(uniqueShop()), id, ctx);
    const url = new URL(seen[0]!.url);
    expect(url.searchParams.get("foo")).toBe("bar");
    expect(url.searchParams.get("measurement_id")).toBe("G-ABC123");
    expect(url.searchParams.get("api_secret")).toBe("s3cret");
    expect(seen[0]!.body.events[0].params.session_id).toBe("1700000005");
  });

  it("appends only the params that are provided", async () => {
    const { ctx, seen } = mockCtx();
    await sgtm({ url: "https://sgtm.example.com/mp/collect", apiSecret: "k" }).purchase(fixtureOrder(uniqueShop()), null, ctx);
    const url = new URL(seen[0]!.url);
    expect(url.searchParams.has("measurement_id")).toBe(false);
    expect(url.searchParams.get("api_secret")).toBe("k");
  });

  it("sends refunds", async () => {
    const { ctx, seen } = mockCtx();
    const refund = fixtureRefund(uniqueShop());
    await sgtm({ url: "https://sgtm.example.com/mp/collect" }).refund!(refund, id, ctx);
    expect(seen[0]!.body.events[0].name).toBe("refund");
    expect(seen[0]!.body.events[0].params.transaction_id).toBe(refund.orderId);
    expect(seen[0]!.body.client_id).toBe("55.66");
  });

  it("throws retryable on 5xx", async () => {
    const err = await sgtm({ url: "https://sgtm.example.com/mp/collect" })
      .purchase(fixtureOrder(uniqueShop()), null, mockCtx(502).ctx)
      .catch((e) => e);
    expect(err).toBeInstanceOf(TargetError);
    expect(err.retryable).toBe(true);
  });

  it("throws non-retryable on an invalid url", async () => {
    const err = await sgtm({ url: "not a url" })
      .purchase(fixtureOrder(uniqueShop()), null, mockCtx().ctx)
      .catch((e) => e);
    expect(err).toBeInstanceOf(TargetError);
    expect(err.retryable).toBe(false);
  });

  it("passes Google's consent signals through at the top level", async () => {
    const { ctx, seen } = mockCtx();
    await sgtm({ url: "https://sgtm.example.com/mp/collect" }).purchase(fixtureOrder(uniqueShop()), { ...id, consent: { marketing: false } }, ctx);
    expect(seen[0]!.body.consent).toEqual({ ad_user_data: "DENIED", ad_personalization: "DENIED" });
  });
});
