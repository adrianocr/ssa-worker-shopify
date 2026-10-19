import { readBodyPrefix } from "./body";
import { TargetError } from "./target";
import type { TargetContext } from "./types";

export interface SendJsonInit {
  method?: string;
  headers?: Record<string, string>;
  /** Serialized with JSON.stringify. */
  body?: unknown;
  timeoutMs?: number;
  /**
   * Keep the response body for the caller to read. Off by default: the body of a 2xx is cancelled,
   * so an unread stream doesn't hold the connection open. GA4's debug mode turns it on.
   */
  readBody?: boolean;
}

const MAX_LOGGED_BODY = 200;
// Only this much of the body is scanned. Redaction can shorten text (a long email becomes
// "[redacted]"), so it scans well past MAX_LOGGED_BODY, but a huge body must not cost CPU time.
const MAX_SCANNED_BODY = 2_000;

// Vendors sometimes echo request fields back in errors. The body ends up in the TargetError
// message, which is logged, so anything that looks like an email, IP address or phone number is
// replaced first. Over-matching (a long numeric id) is fine; this is only for logs.
// The input is cut to MAX_SCANNED_BODY before these run, which keeps the worst case cheap.
const REDACTIONS: RegExp[] = [
  /[^\s"'<>@,;:]{1,64}@[^\s"'<>@,;:]{1,253}\.[A-Za-z]{2,}/g,
  // IPv6, including compressed (::1, 2001:db8::) and IPv4-mapped (::ffff:1.2.3.4) forms.
  // The lookahead needs a hex digit, so a bare "::" (Foo::Bar, a lone ::) is left alone.
  /(?<![\w:])(?=[0-9A-Fa-f:]{0,39}[0-9A-Fa-f])[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}(?:\.\d{1,3}){0,3}(?![\w:])/g,
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/g,
  /\+?\d[\d\s().-]{6,}\d/g,
];

/** Exported for tests. */
export function redact(text: string): string {
  return REDACTIONS.reduce((out, re) => out.replace(re, "[redacted]"), text);
}

/**
 * Sends a JSON request and returns the response when it's 2xx, with its body already cancelled
 * unless `readBody` is set. Network errors, timeouts, 429 and 5xx throw a retryable TargetError;
 * other statuses throw a final one.
 */
export async function sendJson(ctx: TargetContext, url: string, init: SendJsonInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await ctx.fetch(url, {
      method: init.method ?? "POST",
      headers: { "Content-Type": "application/json", ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs ?? 10_000),
    });
  } catch (e) {
    throw new TargetError(`request failed: ${e instanceof Error ? e.message : String(e)}`, true);
  }
  if (res.ok) {
    if (!init.readBody) await res.body?.cancel().catch(() => undefined);
    return res;
  }
  // Only the scanned prefix is read, whatever the vendor sends. It's bytes, so a multi-byte
  // character cut at the end decodes to U+FFFD, which is fine for a log line.
  const prefix = await readBodyPrefix(res, MAX_SCANNED_BODY).catch(() => new Uint8Array(0));
  const raw = new TextDecoder().decode(prefix);
  const text = redact(raw.slice(0, MAX_SCANNED_BODY)).slice(0, MAX_LOGGED_BODY);
  const retryable = res.status >= 500 || res.status === 429;
  throw new TargetError(`HTTP ${res.status}${text ? `: ${text}` : ""}`, retryable);
}
