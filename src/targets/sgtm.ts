import { sendJson } from "../core/http";
import { defineTarget, TargetError } from "../core/target";
import type { TargetContext } from "../core/types";
import { buildPurchase, buildRefund, type Ga4Payload } from "./ga4-payload";

export interface SgtmConfig {
  /** Full collect URL, e.g. https://sgtm.example.com/mp/collect */
  url: string;
  measurementId?: string;
  apiSecret?: string;
}

function endpoint(config: SgtmConfig): string {
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    throw new TargetError(`invalid sGTM url: ${config.url}`, false);
  }
  if (config.measurementId) url.searchParams.set("measurement_id", config.measurementId);
  if (config.apiSecret) url.searchParams.set("api_secret", config.apiSecret);
  return url.toString();
}

async function send(payload: Ga4Payload, config: SgtmConfig, ctx: TargetContext): Promise<void> {
  await sendJson(ctx, endpoint(config), { body: payload });
}

export const sgtm = defineTarget<SgtmConfig>({
  id: "sgtm",
  consent: "analytics",
  required: ["url"],
  async purchase(order, identity, config, ctx) {
    await send(buildPurchase(order, identity, config.measurementId), config, ctx);
  },
  async refund(refund, identity, config, ctx) {
    await send(buildRefund(refund, identity), config, ctx);
  },
});
