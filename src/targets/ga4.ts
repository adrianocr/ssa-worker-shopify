import { sendJson } from "../core/http";
import { defineTarget, TargetError } from "../core/target";
import type { DeliveryResult, TargetContext } from "../core/types";
import { buildPurchase, buildRefund, type Ga4Payload } from "./ga4-payload";

export interface Ga4Config {
  measurementId: string;
  apiSecret: string;
  /** Sends to /debug/mp/collect, which validates but doesn't record events. Debug sends aren't marked delivered. */
  debug?: boolean;
}

const LIVE_URL = "https://www.google-analytics.com/mp/collect";
const DEBUG_URL = "https://www.google-analytics.com/debug/mp/collect";

interface ValidationMessage {
  fieldPath?: string;
  description?: string;
  validationCode?: string;
}

async function send(payload: Ga4Payload, config: Ga4Config, ctx: TargetContext): Promise<void | DeliveryResult> {
  const base = config.debug ? DEBUG_URL : LIVE_URL;
  const url = `${base}?measurement_id=${encodeURIComponent(config.measurementId)}&api_secret=${encodeURIComponent(config.apiSecret)}`;
  const res = await sendJson(ctx, url, { body: payload, readBody: config.debug === true });
  if (!config.debug) return;

  // The debug endpoint answers 200 with validationMessages; empty means valid. The live one stays silent on bad payloads.
  const body = (await res.json().catch(() => ({}))) as { validationMessages?: ValidationMessage[] };
  const messages = body.validationMessages ?? [];
  ctx.log.info("ga4 debug validation", { messages, payload });
  const first = messages[0];
  if (first) {
    throw new TargetError(`ga4 validation failed: ${first.fieldPath ?? "payload"}: ${first.description ?? first.validationCode ?? "invalid"}`, false);
  }
  return { recorded: false };
}

export const ga4 = defineTarget<Ga4Config>({
  id: "ga4",
  consent: "analytics",
  required: ["measurementId", "apiSecret"],
  async purchase(order, identity, config, ctx) {
    return send(buildPurchase(order, identity, config.measurementId), config, ctx);
  },
  async refund(refund, identity, config, ctx) {
    return send(buildRefund(refund, identity), config, ctx);
  },
});
