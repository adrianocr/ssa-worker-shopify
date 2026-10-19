import { describe, expect, it, vi } from "vitest";
import { redact, sendJson } from "../src/core/http";
import { TargetError } from "../src/core/target";
import type { Logger, Target, TargetContext } from "../src/core/types";
import { configWith, fixtureOrder, makeEnv, purchaseMessage, runQueue, uniqueShop } from "./helpers";

function ctxReturning(res: () => Response): TargetContext {
  const log: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log };
  return { shop: "s.myshopify.com", log, fetch: vi.fn(async () => res()) as unknown as typeof fetch };
}

async function failure(res: () => Response): Promise<TargetError> {
  return sendJson(ctxReturning(res), "https://vendor.example/api", { body: {} }).then(
    () => {
      throw new Error("expected a TargetError");
    },
    (e: unknown) => e as TargetError,
  );
}

describe("sendJson error bodies", () => {
  it("keeps the status and redacts an echoed email, phone and IP", async () => {
    const body = JSON.stringify({
      error: { message: "Invalid user bob.smith+tag@example.com from 198.51.100.7 / 2001:db8::1, phone +1 (212) 555-1234", code: 100 },
    });
    const err = await failure(() => new Response(body, { status: 400 }));
    expect(err).toBeInstanceOf(TargetError);
    expect(err.retryable).toBe(false);
    expect(err.message.startsWith("HTTP 400: ")).toBe(true);
    expect(err.message).toContain("Invalid user");
    for (const leaked of ["bob.smith", "example.com", "198.51.100.7", "2001:db8", "555-1234", "212"]) {
      expect(err.message).not.toContain(leaked);
    }
  });

  it("logs at most 200 characters of the body", async () => {
    const err = await failure(() => new Response("e".repeat(5000), { status: 503 }));
    expect(err.retryable).toBe(true);
    expect(err.message).toBe(`HTTP 503: ${"e".repeat(200)}`);
  });

  it("redacts before truncating, so a cut email doesn't survive", async () => {
    const body = `${"x".repeat(190)} alice@example.org`;
    const err = await failure(() => new Response(body, { status: 400 }));
    expect(err.message).not.toContain("alice");
  });

  it("an echoed email doesn't reach the consumer's log", async () => {
    const echo: Target = {
      id: "echo",
      consent: "analytics",
      enabled: true,
      missing: [],
      async purchase(order, _identity, ctx) {
        await sendJson(ctx, "https://vendor.example/api", { body: { email: order.customer.email } });
      },
    };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response('{"error":"customer jane@example.net rejected"}', { status: 422 }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { env } = makeEnv();
      await runQueue(configWith([echo]), env, [purchaseMessage(fixtureOrder(uniqueShop(), { email: "jane@example.net" }))]);
      const logged = JSON.stringify(errorSpy.mock.calls);
      expect(logged).toContain("HTTP 422");
      expect(logged).not.toContain("jane@example.net");
    } finally {
      fetchSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("scans only a bounded prefix, so a huge body without spaces or @ stays cheap", async () => {
    const start = performance.now();
    const err = await failure(() => new Response("a".repeat(200_000), { status: 500 }));
    expect(performance.now() - start).toBeLessThan(200);
    expect(err.message).toBe(`HTTP 500: ${"a".repeat(200)}`);
  });

  it("redacts in linear time even on the whole of a huge body", () => {
    for (const body of ["a".repeat(200_000), "a.".repeat(100_000), `a@${"b".repeat(200_000)}`]) {
      const start = performance.now();
      redact(body);
      expect(performance.now() - start).toBeLessThan(200);
    }
  });

  it("still redacts an email in the first 200 characters of a long body", async () => {
    const body = `{"error":"user carol@example.com not found"} ${"z".repeat(10_000)}`;
    const err = await failure(() => new Response(body, { status: 400 }));
    expect(err.message).toContain("[redacted]");
    expect(err.message).not.toContain("carol");
    expect(err.message).not.toContain("example.com");
  });

  it("redacts compressed and IPv4-mapped IPv6 addresses", () => {
    for (const ip of ["::1", "2001:db8::", "::ffff:1.2.3.4", "fe80::1", "2001:0db8:85a3:0000:0000:8a2e:0370:7334"]) {
      expect(redact(`from ${ip} denied`)).toBe("from [redacted] denied");
    }
    expect(redact("[::1]:8080")).toBe("[[redacted]]:8080");
  });

  it("leaves C++ and Ruby style :: alone", () => {
    for (const text of ["Foo::Bar", "std::vector", "a :: b", "Error: bad: value"]) expect(redact(text)).toBe(text);
  });

  it("leaves ordinary error text alone", () => {
    expect(redact('{"error":{"code":190,"type":"OAuthException"}}')).toBe('{"error":{"code":190,"type":"OAuthException"}}');
  });

  it("reads at most the scanned prefix of an error body that never ends", async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode("e".repeat(512)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const err = await failure(() => new Response(stream, { status: 500 }));
    expect(err.message).toBe(`HTTP 500: ${"e".repeat(200)}`);
    expect(pulls).toBeLessThan(10);
    expect(cancelled).toBe(true);
  });
});

describe("sendJson success bodies", () => {
  function streamed() {
    const state = { cancelled: false };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":true}'));
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return { state, response: () => new Response(body, { status: 200 }) };
  }

  it("cancels the body of a 2xx by default", async () => {
    const { state, response } = streamed();
    await sendJson(ctxReturning(response), "https://vendor.example/api", { body: {} });
    expect(state.cancelled).toBe(true);
  });

  it("leaves the body readable when the caller asks for it", async () => {
    const { state, response } = streamed();
    const res = await sendJson(ctxReturning(response), "https://vendor.example/api", { body: {}, readBody: true });
    expect(state.cancelled).toBe(false);
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('{"ok":true}');
    await reader.cancel();
  });
});
