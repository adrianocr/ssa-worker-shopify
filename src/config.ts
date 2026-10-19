import { defineConfig } from "./core/config";
import { awin } from "./targets/awin";
import { ga4 } from "./targets/ga4";
import { meta, parseContentId } from "./targets/meta";
import { sgtm } from "./targets/sgtm";

// SEND_TEST_ORDERS and ORDER_SOURCES apply to every target, so the core reads them itself
// (src/core/config.ts). They can be set per store in STORES like any other variable.
export default defineConfig((vars) => ({
  webhookSecret: vars.SHOPIFY_WEBHOOK_SECRET,
  targets: [
    ga4({ measurementId: vars.GA4_MEASUREMENT_ID, apiSecret: vars.GA4_API_SECRET, debug: vars.GA4_DEBUG === "true" }),
    sgtm({ url: vars.SGTM_URL, measurementId: vars.SGTM_MEASUREMENT_ID, apiSecret: vars.SGTM_API_SECRET }),
    meta({
      pixelId: vars.META_PIXEL_ID,
      accessToken: vars.META_ACCESS_TOKEN,
      testEventCode: vars.META_TEST_EVENT_CODE,
      apiVersion: vars.META_API_VERSION,
      // Trimmed and lowercased; an unknown value warns once and falls back to variant_id.
      contentId: parseContentId(vars.META_CONTENT_ID),
    }),
    awin({
      advertiserId: vars.AWIN_ADVERTISER_ID,
      apiKey: vars.AWIN_API_KEY,
      commissionGroup: vars.AWIN_COMMISSION_GROUP,
      test: vars.AWIN_TEST === "true",
      cookieDays: vars.AWIN_COOKIE_DAYS ? Number(vars.AWIN_COOKIE_DAYS) : undefined,
    }),
  ],
}));
