export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Letters and digits in any script; drops spaces and punctuation. */
const NON_ALNUM = /[^\p{L}\p{N}]/gu;

export function normalizeEmail(v: string | undefined): string {
  return (v ?? "").trim().toLowerCase();
}

export function normalizePhone(v: string | undefined): string {
  return (v ?? "").replace(/\D/g, "");
}

export function normalizeName(v: string | undefined): string {
  return (v ?? "").trim().toLowerCase();
}

export function normalizeCity(v: string | undefined): string {
  return (v ?? "").toLowerCase().replace(NON_ALNUM, "");
}

export function normalizeState(v: string | undefined): string {
  return (v ?? "").toLowerCase().replace(NON_ALNUM, "");
}

export function normalizeCountry(v: string | undefined): string {
  return (v ?? "").trim().toLowerCase();
}

/** US zips are sent as the 5 digit form; Meta rejects the ZIP+4 suffix. */
export function normalizeZip(v: string | undefined, countryCode?: string): string {
  const zip = (v ?? "").toLowerCase().replace(/[\s-]/g, "");
  return normalizeCountry(countryCode) === "us" ? zip.slice(0, 5) : zip;
}

/** Hashes a normalized value, or returns undefined when nothing is left to hash. */
export async function hashIfPresent(normalized: string): Promise<string | undefined> {
  return normalized === "" ? undefined : sha256Hex(normalized);
}
