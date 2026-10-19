import type { ConsentCategory, DeliveryResult, Identity, Order, Refund, Target, TargetContext } from "./types";

/** Throw from a target to report a failed send. Retryable failures are re-enqueued with backoff. */
export class TargetError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "TargetError";
  }
}

export interface TargetSpec<C> {
  id: string;
  consent: ConsentCategory;
  required: (keyof C)[];
  purchase(order: Order, identity: Identity | null, config: C, ctx: TargetContext): Promise<void | DeliveryResult>;
  refund?(refund: Refund, identity: Identity | null, config: C, ctx: TargetContext): Promise<void | DeliveryResult>;
}

function isMissing(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

/**
 * Turns a target spec into a factory for src/config.ts. Values come straight from env vars, so any
 * of them can be undefined; a missing required one disables the target instead of throwing.
 */
export function defineTarget<C>(spec: TargetSpec<C>): (config: { [K in keyof C]?: C[K] }) => Target {
  return (config) => {
    const missing = spec.required.filter((k) => isMissing(config[k])).map(String);
    // Safe once `missing` is empty, and the target is never called otherwise.
    const full = config as C;
    const target: Target = {
      id: spec.id,
      consent: spec.consent,
      enabled: missing.length === 0,
      missing,
      purchase: (order, identity, ctx) => spec.purchase(order, identity, full, ctx),
    };
    const refund = spec.refund;
    if (refund) target.refund = (r, identity, ctx) => refund(r, identity, full, ctx);
    return target;
  };
}
