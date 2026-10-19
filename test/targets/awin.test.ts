import { describe, expect, it, vi } from "vitest";
import { TargetError } from "../../src/core/target";
import type { Identity, Logger, Order, TargetContext } from "../../src/core/types";
import { awin, awinChannel } from "../../src/targets/awin";

function makeCtx(respond: () => Response = () => new Response("{}", { status: 200 })) {
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => respond());
  const log: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => log,
  };
  const ctx: TargetContext = { shop: "s.myshopify.com", log, fetch: fetchMock as unknown as typeof fetch };
  return { ctx, fetchMock, log };
}

function makeOrder(patch: Partial<Order> = {}): Order {
  return {
    shop: "s.myshopify.com",
    id: "1001",
    name: "#1001",
    currency: "USD",
    total: 93.37,
    subtotal: 84,
    tax: 6.37,
    shipping: 3,
    discount: 0,
    createdAt: new Date().toISOString(),
    lines: [],
    customer: {},
    ...patch,
  };
}

const DAY = 24 * 60 * 60 * 1000;

function withAwc(value = "awc-click-1", at = Date.now(), others: Identity["clickIds"] = {}): Identity {
  return {
    cookies: {},
    clickIds: { ...others, awc: { value, at } },
    consent: { marketing: true },
    collectedAt: Date.now(),
  };
}

const config = { advertiserId: "9999", apiKey: "key_abc" };

function sentBody(fetchMock: ReturnType<typeof makeCtx>["fetchMock"]) {
  return JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
}

describe("awin target", () => {
  it("is a marketing target with no refund", () => {
    const t = awin(config);
    expect(t.id).toBe("awin");
    expect(t.consent).toBe("marketing");
    expect(t.enabled).toBe(true);
    expect(t.refund).toBeUndefined();
  });

  it("is disabled without required config", () => {
    const t = awin({ advertiserId: "9999" });
    expect(t.enabled).toBe(false);
    expect(t.missing).toEqual(["apiKey"]);
  });

  it("posts the order with the api key header", async () => {
    const { ctx, fetchMock } = makeCtx();
    await awin(config).purchase(makeOrder(), withAwc(), ctx);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.awin.com/s2s/advertiser/9999/orders");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("key_abc");
    expect(headers["Content-Type"]).toBe("application/json");

    expect(sentBody(fetchMock)).toEqual({
      orders: [
        {
          orderReference: "1001",
          amount: 84,
          channel: "aw",
          currency: "USD",
          awc: "awc-click-1",
          commissionGroups: [{ code: "DEFAULT", amount: 84 }],
        },
      ],
    });
  });

  it("uses the configured commission group and test flag, and asks not to record a test send", async () => {
    const { ctx, fetchMock } = makeCtx();
    const result = await awin({ ...config, commissionGroup: "NEW", test: true }).purchase(makeOrder(), withAwc(), ctx);
    const order = sentBody(fetchMock).orders[0];
    expect(order.commissionGroups).toEqual([{ code: "NEW", amount: 84 }]);
    expect(order.isTest).toBe(true);
    expect(result).toEqual({ recorded: false });
  });

  it("omits isTest when test is off and records the send", async () => {
    const { ctx, fetchMock } = makeCtx();
    const result = await awin({ ...config, test: false }).purchase(makeOrder(), withAwc(), ctx);
    expect("isTest" in sentBody(fetchMock).orders[0]).toBe(false);
    expect(result).toBeUndefined();
  });

  it("skips with a debug log and records nothing when there is no awc click id", async () => {
    const identities: (Identity | null)[] = [
      null,
      { ...withAwc(), clickIds: {} },
      { ...withAwc(), clickIds: { gclid: { value: "g", at: 1 } } },
    ];
    for (const identity of identities) {
      const { ctx, fetchMock, log } = makeCtx();
      expect(await awin(config).purchase(makeOrder(), identity, ctx)).toEqual({ recorded: false, skipped: "no awc click id" });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(log.debug).toHaveBeenCalledTimes(1);
    }
  });

  it("skips when the awc value is empty", async () => {
    const { ctx, fetchMock } = makeCtx();
    expect(await awin(config).purchase(makeOrder(), withAwc(""), ctx)).toEqual({ recorded: false, skipped: "no awc click id" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rounds the commissionable amount to 2 decimals", async () => {
    const { ctx, fetchMock } = makeCtx();
    await awin(config).purchase(makeOrder({ total: 100.1, tax: 0.1, shipping: 0.005 }), withAwc(), ctx);
    expect(sentBody(fetchMock).orders[0].amount).toBe(100.0);

    const second = makeCtx();
    await awin(config).purchase(makeOrder({ total: 10.3, tax: 0.1, shipping: 0.1 }), withAwc(), second.ctx);
    expect(sentBody(second.fetchMock).orders[0].amount).toBe(10.1);
  });

  it("never sends a negative amount", async () => {
    const { ctx, fetchMock } = makeCtx();
    await awin(config).purchase(makeOrder({ total: 5, tax: 3, shipping: 4 }), withAwc(), ctx);
    const order = sentBody(fetchMock).orders[0];
    expect(order.amount).toBe(0);
    expect(order.commissionGroups[0].amount).toBe(0);
  });

  it("strips only the leading # and truncates the reference to 50 chars", async () => {
    const { ctx, fetchMock } = makeCtx();
    await awin(config).purchase(makeOrder({ name: `#${"A".repeat(60)}` }), withAwc(), ctx);
    expect(sentBody(fetchMock).orders[0].orderReference).toBe("A".repeat(50));

    const second = makeCtx();
    await awin(config).purchase(makeOrder({ name: "EU#1002" }), withAwc(), second.ctx);
    expect(sentBody(second.fetchMock).orders[0].orderReference).toBe("EU#1002");
  });

  it("falls back to the order id when the name is empty", async () => {
    const { ctx, fetchMock } = makeCtx();
    await awin(config).purchase(makeOrder({ name: "#" }), withAwc(), ctx);
    expect(sentBody(fetchMock).orders[0].orderReference).toBe("1001");
  });

  it("throws a non-retryable TargetError on 4xx", async () => {
    const { ctx } = makeCtx(() => new Response("forbidden", { status: 403 }));
    const err = await awin(config).purchase(makeOrder(), withAwc(), ctx).catch((e) => e);
    expect(err).toBeInstanceOf(TargetError);
    expect(err.retryable).toBe(false);
  });

  it.each([429, 500, 502])("throws a retryable TargetError on %i", async (status) => {
    const { ctx } = makeCtx(() => new Response("", { status }));
    const err = await awin(config).purchase(makeOrder(), withAwc(), ctx).catch((e) => e);
    expect(err).toBeInstanceOf(TargetError);
    expect(err.retryable).toBe(true);
  });

  describe("channel", () => {
    const now = Date.parse("2026-10-17T12:00:00Z");

    it("is aw when awc is the most recent click", () => {
      const id = withAwc("a", now - DAY, { gclid: { value: "g", at: now - 2 * DAY } });
      expect(awinChannel(id, 30, now)).toEqual({ awc: "a", channel: "aw" });
    });

    it("is other when another paid click came after awc", () => {
      const id = withAwc("a", now - 2 * DAY, { fbclid: { value: "f", at: now - DAY } });
      expect(awinChannel(id, 30, now)).toEqual({ awc: "a", channel: "other" });
    });

    it("ignores an awc older than the cookie window", () => {
      expect(awinChannel(withAwc("a", now - 31 * DAY), 30, now)).toBeNull();
      expect(awinChannel(withAwc("a", now - 31 * DAY), 45, now)).toEqual({ awc: "a", channel: "aw" });
    });

    it("sends channel other on the wire", async () => {
      const { ctx, fetchMock } = makeCtx();
      const id = withAwc("a", Date.now() - DAY, { gclid: { value: "g", at: Date.now() - 1000 } });
      await awin(config).purchase(makeOrder(), id, ctx);
      expect(sentBody(fetchMock).orders[0]).toMatchObject({ awc: "a", channel: "other" });
    });

    it("measures the cookie window from the order's creation time, not the send time", async () => {
      // Created 30 days ago with an awc set 35 days ago: 5 days old when the order was placed, but
      // 35 days old now, so a window measured from the send time would skip it.
      const order = makeOrder({ createdAt: new Date(Date.now() - 30 * DAY).toISOString() });
      const id = withAwc("a", Date.now() - 35 * DAY);
      const sent = makeCtx();
      await awin(config).purchase(order, id, sent.ctx);
      expect(sent.fetchMock).toHaveBeenCalledTimes(1);
      expect(sentBody(sent.fetchMock).orders[0]).toMatchObject({ awc: "a", channel: "aw" });

      // An awc older than the window at order time is still skipped.
      const recentOrder = makeOrder({ createdAt: new Date(Date.now() - DAY).toISOString() });
      const skipped = makeCtx();
      expect(await awin(config).purchase(recentOrder, id, skipped.ctx)).toEqual({ recorded: false, skipped: "awc older than 30 days" });

      // An unparseable createdAt falls back to now.
      const fallback = makeCtx();
      await awin(config).purchase(makeOrder({ createdAt: "nope" }), withAwc("a", Date.now() - DAY), fallback.ctx);
      expect(fallback.fetchMock).toHaveBeenCalledTimes(1);
    });

    it("skips an expired awc with its own reason, honoring cookieDays", async () => {
      const old = withAwc("a", Date.now() - 31 * DAY);
      const first = makeCtx();
      expect(await awin(config).purchase(makeOrder(), old, first.ctx)).toEqual({ recorded: false, skipped: "awc older than 30 days" });
      expect(first.fetchMock).not.toHaveBeenCalled();

      const second = makeCtx();
      await awin({ ...config, cookieDays: 60 }).purchase(makeOrder(), old, second.ctx);
      expect(second.fetchMock).toHaveBeenCalledTimes(1);

      const third = makeCtx();
      expect(await awin({ ...config, cookieDays: Number("nope") }).purchase(makeOrder(), old, third.ctx)).toMatchObject({ recorded: false });
    });
  });
});
