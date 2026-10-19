import { describe, expect, it, vi } from "vitest";
import { createLogger, safeLogger } from "../src/core/log";
import type { Logger } from "../src/core/types";

describe("logger", () => {
  it("swallows a console that throws", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("console down");
    });
    try {
      // createLogger reads console when it's created, so make it after the spy.
      const logger = createLogger({ a: 1 });
      expect(() => logger.warn("x")).not.toThrow();
      expect(() => logger.child({ b: 2 }).warn("y")).not.toThrow();
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("safeLogger keeps a throwing logger, and a throwing child(), from throwing", () => {
    const fail = () => {
      throw new Error("log sink down");
    };
    const broken: Logger = { debug: fail, info: fail, warn: fail, error: fail, child: fail };
    const safe = safeLogger(broken);
    for (const level of ["debug", "info", "warn", "error"] as const) expect(() => safe[level]("x")).not.toThrow();
    const child = safe.child({ a: 1 });
    expect(() => child.error("x")).not.toThrow();
    expect(() => child.child({ b: 2 }).info("y")).not.toThrow();
  });
});
