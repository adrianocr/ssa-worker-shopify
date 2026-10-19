import type { Logger } from "./types";

const PREFIX = "[ssa]";

function clean(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    out[k] = v instanceof Error ? v.message : v;
  }
  return out;
}

// Every method swallows its own errors: logging must never change control flow.
export function createLogger(fields: Record<string, unknown> = {}): Logger {
  const write =
    (fn: (...args: unknown[]) => void) =>
    (msg: string, data?: Record<string, unknown>) => {
      try {
        fn(`${PREFIX} ${msg}`, clean({ ...fields, ...data }));
      } catch {
        // Nothing left to report to.
      }
    };
  return {
    debug: write(console.debug),
    info: write(console.log),
    warn: write(console.warn),
    error: write(console.error),
    child: (more) => createLogger({ ...fields, ...more }),
  };
}

const LEVELS = ["debug", "info", "warn", "error"] as const;

/**
 * Wraps any Logger, including a replaced or mocked one, so none of its methods can throw. Methods
 * are looked up at call time, so spies on the wrapped logger still see the calls. A child that
 * can't be made gets a logger that drops everything.
 */
export function safeLogger(logger: Logger): Logger {
  const out = {} as Logger;
  for (const level of LEVELS) {
    out[level] = (msg, data) => {
      try {
        logger[level](msg, data);
      } catch {
        // Nothing left to report to.
      }
    };
  }
  out.child = (more) => {
    try {
      return safeLogger(logger.child(more));
    } catch {
      return safeLogger({ debug() {}, info() {}, warn() {}, error() {}, child: () => out });
    }
  };
  return out;
}

export const log = createLogger();
