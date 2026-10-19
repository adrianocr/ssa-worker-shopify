/**
 * Rounds to two decimals. Number.EPSILON nudges values like 1.005, which binary floating point
 * stores as 1.00499..., so they round up the way a person would.
 */
export function money(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
