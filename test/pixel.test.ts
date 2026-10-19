import { describe, expect, it, vi } from "vitest";
// @ts-expect-error vite resolves ?raw imports; the Workers types do not declare them
import pixelSource from "../pixel/custom-pixel.js?raw";
import { parseCollect } from "../src/core/collect";

type Handler = (event: any) => unknown;

// Runs the pasted file as-is, the way Shopify does: top-level code with sandbox globals.
function runPixel(opts: { cookieAll?: string; cookieNamed?: Record<string, string>; storage?: Record<string, string>; privacy?: object } = {}) {
  const handlers: Record<string, Handler> = {};
  const privacyHandlers: Record<string, Handler> = {};
  const storage: Record<string, string> = { ...opts.storage };
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  const browser = {
    cookie: {
      get: async (name?: string) => (name === undefined ? (opts.cookieAll ?? "") : (opts.cookieNamed?.[name] ?? "")),
    },
    localStorage: {
      getItem: async (k: string) => storage[k] ?? null,
      setItem: async (k: string, v: string) => void (storage[k] = v),
    },
  };
  const analytics = { subscribe: (name: string, fn: Handler) => void (handlers[name] = fn) };
  const customerPrivacy = { subscribe: (name: string, fn: Handler) => void (privacyHandlers[name] = fn) };
  const init = {
    data: { shop: { myshopifyDomain: "demo.myshopify.com" } },
    customerPrivacy: opts.privacy ?? {
      analyticsProcessingAllowed: true,
      marketingAllowed: false,
      preferencesProcessingAllowed: true,
      saleOfDataAllowed: false,
    },
  };
  new Function("analytics", "browser", "init", "customerPrivacy", "fetch", pixelSource)(analytics, browser, init, customerPrivacy, fetchMock);
  return { handlers, privacyHandlers, storage, fetchMock };
}

const pageEvent = (href: string) => ({ clientId: "c1", context: { document: { location: { href } } } });
const checkoutEvent = (token: string | null, orderId?: string) => ({
  clientId: "shopify-client",
  context: { document: { location: { href: "https://demo.com/checkouts/cn/abc" } } },
  data: { checkout: { token, order: orderId ? { id: orderId } : null } },
});

function sentBody(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { keepalive?: boolean; headers?: unknown; body: string }];
  return { url, init, body: JSON.parse(init.body) };
}

describe("custom pixel", () => {
  it("stores click ids from page_viewed and sends them on checkout_started", async () => {
    const { handlers, fetchMock, storage } = runPixel({ cookieAll: "_ga=GA1.1.1.2; _ga_ABC=GS1.1.9.; other=x; _fbp=fb.1.2.3" });
    handlers.page_viewed(pageEvent("https://demo.com/?gclid=G1&utm_source=x&awc=A1"));
    await handlers.checkout_started(checkoutEvent("tok1"));

    expect(Object.keys(JSON.parse(storage.ssa_click_ids)).sort()).toEqual(["awc", "gclid"]);
    const { url, init, body } = sentBody(fetchMock);
    expect(url).toBe("https://ssa-worker-shopify.YOUR-SUBDOMAIN.workers.dev/collect");
    expect(init.keepalive).toBe(true);
    expect(init.headers).toEqual({ "Content-Type": "text/plain" });
    expect(body.shop).toBe("demo.myshopify.com");
    expect(body.checkoutToken).toBe("tok1");
    expect(body.clientId).toBe("shopify-client");
    expect(body.cookies).toEqual({ _ga: "GA1.1.1.2", _ga_ABC: "GS1.1.9.", _fbp: "fb.1.2.3" });
    expect(body.clickIds.gclid.value).toBe("G1");
    expect(body.consent).toEqual({ analytics: true, marketing: false, preferences: true, sale_of_data: false });
    expect(body.orderId).toBeUndefined();
    expect(body.pageUrl).toBe("https://demo.com/checkouts/cn/abc");
  });

  it("overwrites a click id on a new value and keeps the time on the same value", async () => {
    const { handlers, storage } = runPixel({ storage: { ssa_click_ids: JSON.stringify({ gclid: { value: "OLD", at: 1000 }, fbclid: { value: "F", at: 2000 } }) } });
    handlers.page_viewed(pageEvent("https://demo.com/?gclid=NEW&fbclid=F"));
    await handlers.checkout_started(checkoutEvent("t"));
    const ids = JSON.parse(storage.ssa_click_ids);
    expect(ids.gclid.value).toBe("NEW");
    expect(ids.gclid.at).toBeGreaterThan(1000);
    expect(ids.fbclid).toEqual({ value: "F", at: 2000 });
  });

  it("falls back to named cookie reads when the full cookie string is empty", async () => {
    const { handlers, fetchMock } = runPixel({ cookieAll: "", cookieNamed: { _ga: "GA1.1.5.6", _fbc: "fb.1.1.abc" } });
    await handlers.checkout_started(checkoutEvent("t"));
    expect(sentBody(fetchMock).body.cookies).toEqual({ _ga: "GA1.1.5.6", _fbc: "fb.1.1.abc" });
  });

  it("doesn't send the order id on checkout_completed and follows consent updates", async () => {
    const { handlers, privacyHandlers, fetchMock } = runPixel();
    privacyHandlers.visitorConsentCollected({ customerPrivacy: { analyticsProcessingAllowed: false, marketingAllowed: true } });
    await handlers.checkout_completed(checkoutEvent("t", "gid://shopify/OrderIdentity/42"));
    const { body } = sentBody(fetchMock);
    expect(body).not.toHaveProperty("orderId");
    expect(body.consent).toEqual({ analytics: false, marketing: true });
  });

  it("builds a body the worker accepts and carries no purchase data", async () => {
    const { handlers, fetchMock } = runPixel({ cookieAll: "_ga=GA1.1.1.2" });
    handlers.page_viewed(pageEvent("https://demo.com/?ttclid=T"));
    await handlers.checkout_completed(checkoutEvent("tok", "gid://shopify/OrderIdentity/7"));
    const { body } = sentBody(fetchMock);
    const parsed = parseCollect(body);
    expect(parsed?.shop).toBe("demo.myshopify.com");
    expect(parsed?.clickIds.ttclid.value).toBe("T");
    expect(Object.keys(body).sort()).toEqual(["checkoutToken", "clickIds", "clientId", "consent", "cookies", "pageUrl", "shop"]);
  });

  it("skips events without a checkout token and swallows fetch errors", async () => {
    const { handlers, fetchMock } = runPixel();
    await handlers.checkout_started(checkoutEvent(null));
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await expect(handlers.checkout_started(checkoutEvent("t"))).resolves.toBeUndefined();
  });
});
