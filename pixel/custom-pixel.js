/*
 * Server Side Analytics: Shopify custom pixel
 *
 * Paste this file into Shopify admin > Settings > Customer events > Add custom pixel.
 *
 * What it does
 *   - Remembers ad click ids (gclid, fbclid, ttclid, awc and friends) from landing URLs
 *     in this browser's localStorage. Nothing leaves the browser at that point.
 *   - When a checkout starts or completes, it sends one small request to your worker:
 *     the shop domain, the checkout token, Shopify's client id, the ad-platform
 *     cookies (_ga, _ga_*, _fbp, _fbc, _ttp), the stored click ids, the visitor's
 *     consent choices and the checkout page URL.
 *
 * What it does NOT do
 *   - It never reports purchases, order totals, items, emails or any customer details.
 *     Purchases and refunds come from Shopify webhooks, which the worker verifies.
 *   - It never sends anything to a third party. The only destination is WORKER_URL.
 */

// Your deployed worker, without a trailing slash.
const WORKER_URL = "https://ssa-worker-shopify.YOUR-SUBDOMAIN.workers.dev";

// Optional. Your GA4 measurement id (G-XXXXXXXXXX). Only used as a fallback to read the
// GA4 session cookie by name when the full cookie string isn't available.
const GA4_MEASUREMENT_ID = "";

// Set to true to log what the pixel reads and sends in the browser console.
const DEBUG = false;

const CLICK_ID_PARAMS = ["gclid", "gbraid", "wbraid", "fbclid", "ttclid", "msclkid", "awc"];
const STORAGE_KEY = "ssa_click_ids";
const MAX_VALUE_LENGTH = 1024; // the worker drops longer values

function log(...args) {
  if (DEBUG) console.log("[ssa-pixel]", ...args);
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isWantedCookie(name) {
  return name === "_ga" || name.startsWith("_ga_") || name === "_fbp" || name === "_fbc" || name === "_ttp";
}

// "a=1; b=2" -> { a: "1", b: "2" }, keeping only the cookies we use.
function parseCookies(cookieString) {
  const cookies = {};
  if (typeof cookieString !== "string") return cookies;
  for (const part of cookieString.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    const value = safeDecode(part.slice(eq + 1).trim());
    if (isWantedCookie(name) && value && value.length <= MAX_VALUE_LENGTH) cookies[name] = value;
  }
  return cookies;
}

async function readCookies() {
  try {
    const all = parseCookies(await browser.cookie.get());
    if (Object.keys(all).length > 0) return all;
  } catch (error) {
    log("cookie.get() with no name failed", error);
  }

  const names = ["_ga", "_fbp", "_fbc", "_ttp"];
  if (GA4_MEASUREMENT_ID) names.push("_ga_" + GA4_MEASUREMENT_ID.replace(/^G-/, ""));
  const cookies = {};
  for (const name of names) {
    try {
      const value = await browser.cookie.get(name);
      if (value && value.length <= MAX_VALUE_LENGTH) cookies[name] = safeDecode(value);
    } catch (error) {
      log("cookie.get(" + name + ") failed", error);
    }
  }
  return cookies;
}

async function loadClickIds() {
  try {
    const parsed = JSON.parse((await browser.localStorage.getItem(STORAGE_KEY)) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Last click wins: a new value replaces the old one. The same value keeps its first-seen time.
async function captureClickIds(href) {
  try {
    const params = new URL(href).searchParams;
    const stored = await loadClickIds();
    let changed = false;
    for (const name of CLICK_ID_PARAMS) {
      const value = params.get(name);
      if (!value || value.length > MAX_VALUE_LENGTH) continue;
      if (stored[name] && stored[name].value === value) continue;
      stored[name] = { value, at: Date.now() };
      changed = true;
    }
    if (changed) {
      await browser.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
      log("stored click ids", stored);
    }
  } catch (error) {
    log("captureClickIds failed", error);
  }
}

// Shopify's flags map one to one onto the worker's consent categories.
// Only real booleans are sent, so an unknown choice stays unknown on the worker.
function toConsent(privacy) {
  const consent = {};
  if (!privacy) return consent;
  const map = {
    analytics: privacy.analyticsProcessingAllowed,
    marketing: privacy.marketingAllowed,
    preferences: privacy.preferencesProcessingAllowed,
    sale_of_data: privacy.saleOfDataAllowed,
  };
  for (const [category, allowed] of Object.entries(map)) {
    if (typeof allowed === "boolean") consent[category] = allowed;
  }
  return consent;
}

let consent = toConsent(init.customerPrivacy);

// Shopify's docs show customerPrivacy both as a sandbox global and as api.customerPrivacy.
try {
  const privacyApi =
    typeof customerPrivacy !== "undefined" ? customerPrivacy : typeof api !== "undefined" ? api.customerPrivacy : undefined;
  if (privacyApi) {
    privacyApi.subscribe("visitorConsentCollected", (event) => {
      consent = toConsent(event.customerPrivacy);
      log("consent updated", consent);
    });
  }
} catch (error) {
  log("consent subscribe failed", error);
}

// Page views can overlap with the next checkout event, so sends wait for the latest capture.
let pendingCapture = Promise.resolve();

analytics.subscribe("page_viewed", (event) => {
  pendingCapture = captureClickIds(event.context.document.location.href);
});

async function send(event) {
  try {
    await pendingCapture;
    const checkout = event.data && event.data.checkout;
    const checkoutToken = checkout && checkout.token;
    if (!checkoutToken) return;

    const payload = {
      shop: init.data.shop.myshopifyDomain,
      checkoutToken,
      clientId: event.clientId,
      cookies: await readCookies(),
      clickIds: await loadClickIds(),
      consent,
      pageUrl: event.context.document.location.href,
    };

    log("POST /collect", payload);
    // text/plain keeps this a "simple" request, so the browser skips the CORS preflight.
    const response = await fetch(WORKER_URL + "/collect", {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(payload),
    });
    log("/collect responded", response.status);
  } catch (error) {
    log("send failed", error);
  }
}

analytics.subscribe("checkout_started", send);
analytics.subscribe("checkout_completed", send);
