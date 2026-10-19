import { sendJson } from "../core/http";
import { money } from "../core/money";
import { defineTarget } from "../core/target";
import type { Identity } from "../core/types";

export interface AwinConfig {
  advertiserId: string;
  apiKey: string;
  /** Defaults to DEFAULT. */
  commissionGroup?: string;
  /** Marks orders as test conversions so Awin doesn't track them. Test sends aren't marked delivered. */
  test?: boolean;
  /**
   * Days a click id counts toward the channel decision, and how old an awc may be before the order
   * is no longer Awin's. Defaults to 30. Match it to your program's cookie length.
   */
  cookieDays?: number;
}

const MAX_REFERENCE_LENGTH = 50;
export const DEFAULT_COOKIE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function cookieDays(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : DEFAULT_COOKIE_DAYS;
}

/**
 * Awin's channel parameter (https://help.awin.com/developers/docs/channel-parameter) names the
 * channel "deemed as the last-click referrer": `aw` when it was Awin, another label when it was
 * not, so Awin can deduplicate against other paid channels. The page's examples for other channels
 * are `display`, `ppc` and `email`; it doesn't list `other`, which is the label used here because
 * the worker only knows that another click id came later, not what kind of channel it was.
 * Click ids older than the cookie window at `at` (the order's creation time) are ignored, so a
 * send delayed by retries doesn't expire a click that counted when the order was placed. Returns
 * null when there's no usable awc.
 */
export function awinChannel(identity: Identity | null, days: number, at = Date.now()): { awc: string; channel: "aw" | "other" } | null {
  const since = at - days * DAY_MS;
  const clicks = Object.entries(identity?.clickIds ?? {}).filter(([, c]) => c.value && c.at >= since);
  const awc = clicks.find(([name]) => name === "awc")?.[1];
  if (!awc) return null;
  const later = clicks.some(([name, c]) => name !== "awc" && c.at > awc.at);
  return { awc: awc.value, channel: later ? "other" : "aw" };
}

export const awin = defineTarget<AwinConfig>({
  id: "awin",
  consent: "marketing",
  required: ["advertiserId", "apiKey"],
  async purchase(order, identity, config, ctx) {
    const days = cookieDays(config.cookieDays);
    const created = Date.parse(order.createdAt);
    const click = awinChannel(identity, days, Number.isFinite(created) ? created : Date.now());
    if (!click) {
      // Nothing was sent, so don't mark the order delivered.
      const reason = identity?.clickIds.awc?.value ? `awc older than ${days} days` : "no awc click id";
      ctx.log.debug(`awin: ${reason}, skipping`, { orderId: order.id });
      return { recorded: false, skipped: reason };
    }

    // Commissionable amount excludes tax and shipping.
    const amount = money(Math.max(0, order.total - order.tax - order.shipping));
    const reference = order.name.replace(/^#/, "").slice(0, MAX_REFERENCE_LENGTH) || order.id;

    const url = `https://api.awin.com/s2s/advertiser/${encodeURIComponent(config.advertiserId)}/orders`;
    await sendJson(ctx, url, {
      headers: { "x-api-key": config.apiKey },
      body: {
        orders: [
          {
            orderReference: reference,
            amount,
            channel: click.channel,
            currency: order.currency,
            awc: click.awc,
            commissionGroups: [{ code: config.commissionGroup || "DEFAULT", amount }],
            ...(config.test ? { isTest: true } : {}),
          },
        ],
      },
    });
    ctx.log.info("awin: purchase sent", { orderId: order.id, channel: click.channel, test: config.test === true });
    return config.test ? { recorded: false } : undefined;
  },
});
