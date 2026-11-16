import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HttpError,
  fetchHttp,
  fetchJson,
  fetchText,
  isAbortError,
  isHttpError,
  parseRetryAfter,
} from "../core/http";

function makeResponse(
  opts: {
    status?: number;
    headers?: Record<string, string>;
    json?: () => Promise<unknown>;
    text?: () => Promise<string>;
  } = {},
): Response {
  const status = opts.status ?? 200;
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    lower[k.toLowerCase()] = v;
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => lower[k.toLowerCase()] ?? null },
    json: opts.json ?? (async () => ({})),
    text: opts.text ?? (async () => ""),
  } as unknown as Response;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds and HTTP-dates and rejects invalid values", () => {
    const now = Date.parse("2026-11-16T10:00:00.000Z");
    expect(parseRetryAfter("0", now)).toBe(0);
    expect(parseRetryAfter(" 45 ", now)).toBe(45_000);
    expect(parseRetryAfter("Mon, 16 Nov 2026 10:01:30 GMT", now)).toBe(90_000);
    expect(parseRetryAfter("Mon, 16 Nov 2026 09:59:00 GMT", now)).toBe(0);

    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter(undefined, now)).toBeNull();
    expect(parseRetryAfter("", now)).toBeNull();
    expect(parseRetryAfter("-5", now)).toBeNull();
    expect(parseRetryAfter("1.5", now)).toBeNull();
    expect(parseRetryAfter("not-a-date", now)).toBeNull();
    expect(parseRetryAfter("9999999999999999", now)).toBeNull();
  });
});

describe("fetchHttp / fetchJson / fetchText", () => {
  it("preserves status and headers on success and cleans up timers/listeners", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const removeSpy = vi.spyOn(parent.signal, "removeEventListener");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        makeResponse({
          status: 200,
          headers: {
            Link: '<https://api.example.com?page=3>; rel="last"',
            "X-Custom": "abc",
          },
          json: async () => ({ ok: true }),
        }),
      ),
    );

    const res = await fetchJson<{ ok: boolean }>("https://api.example.com/items", {
      signal: parent.signal,
      timeoutMs: 5000,
    });

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.noContent).toBe(false);
    expect(res.data).toEqual({ ok: true });
    expect(res.headers.get("link")).toContain('page=3');
    expect(res.headers.get("x-custom")).toBe("abc");
    expect(vi.getTimerCount()).toBe(0);
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it("times out during initial fetch when headers never arrive", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const removeSpy = vi.spyOn(parent.signal, "removeEventListener");
    let capturedSignal: AbortSignal | null | undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn((_url: unknown, init?: RequestInit) => {
        capturedSignal = init?.signal;
        return new Promise<Response>(() => {});
      }),
    );

    const promise = fetchJson("https://api.example.com/slow", {
      signal: parent.signal,
      timeoutMs: 2000,
    });
    const assertion = expect(promise).rejects.toMatchObject({
      name: "HttpError",
      kind: "timeout",
    });

    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(capturedSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it("enforces timeout across slow body consumption even after headers arrive", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const removeSpy = vi.spyOn(parent.signal, "removeEventListener");
    let capturedSignal: AbortSignal | null | undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        capturedSignal = init?.signal;
        // Headers arrive after 1500ms, then body hangs ignoring signal
        await new Promise((r) => setTimeout(r, 1500));
        return makeResponse({
          status: 200,
          json: () => new Promise(() => {}),
        });
      }),
    );

    const promise = fetchJson("https://api.example.com/slow-body", {
      signal: parent.signal,
      timeoutMs: 2500,
    });
    const assertion = expect(promise).rejects.toMatchObject({
      name: "HttpError",
      kind: "timeout",
    });

    await vi.advanceTimersByTimeAsync(1500);
    expect(capturedSignal?.aborted).toBe(false);
    // Remaining budget is 1000ms (total 2500ms, NOT reset per phase)
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(capturedSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it("honors parent abort before request, during fetch, and during slow body read", async () => {
    vi.useFakeTimers();

    // 1. Pre-aborted
    const preAborted = new AbortController();
    preAborted.abort();
    const neverFetch = vi.fn();
    vi.stubGlobal("fetch", neverFetch);
    await expect(
      fetchJson("https://api.example.com/pre", { signal: preAborted.signal }),
    ).rejects.toSatisfy((err: unknown) => isHttpError(err, "aborted") && isAbortError(err));
    expect(neverFetch).not.toHaveBeenCalled();

    // 2. Aborted during slow body read (even if json() ignores signal)
    const duringBody = new AbortController();
    const removeSpy = vi.spyOn(duringBody.signal, "removeEventListener");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        makeResponse({
          status: 200,
          json: () => new Promise(() => {}),
        }),
      ),
    );

    const p = fetchJson("https://api.example.com/body-abort", {
      signal: duringBody.signal,
      timeoutMs: 10_000,
    });
    await Promise.resolve();
    duringBody.abort();

    await expect(p).rejects.toSatisfy(
      (err: unknown) => isHttpError(err, "aborted") && isAbortError(err),
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it("distinguishes network, http (preserving status/headers/Retry-After), and decode errors", async () => {
    // Network error
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(fetchJson("https://api.example.com/net")).rejects.toSatisfy(
      (err: unknown) => isHttpError(err, "network") && (err as HttpError).status === undefined,
    );

    // HTTP 429 error with Retry-After and headers preserved, body not parsed
    const jsonSpy = vi.fn(async () => ({ bad: true }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        makeResponse({
          status: 429,
          headers: { "Retry-After": "12", "X-RateLimit-Remaining": "0" },
          json: jsonSpy,
        }),
      ),
    );
    await expect(fetchJson("https://api.example.com/429")).rejects.toSatisfy((err: unknown) => {
      if (!isHttpError(err, "http")) return false;
      expect(err.status).toBe(429);
      expect(err.retryAfterMs).toBe(12_000);
      expect(err.headers?.get("x-ratelimit-remaining")).toBe("0");
      return true;
    });
    expect(jsonSpy).not.toHaveBeenCalled();

    // Decode error
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        makeResponse({
          status: 200,
          json: async () => {
            throw new SyntaxError("Unexpected token <");
          },
        }),
      ),
    );
    await expect(fetchJson("https://api.example.com/bad-json")).rejects.toSatisfy(
      (err: unknown) => isHttpError(err, "decode") && (err as HttpError).status === 200,
    );
  });

  it("handles no-content branches (204, 205, 304, HEAD, Content-Length: 0) without forcing JSON", async () => {
    const jsonBomb = vi.fn(async () => {
      throw new SyntaxError("must not parse JSON on no-content");
    });
    const textBomb = vi.fn(async () => {
      throw new Error("must not read text on no-content");
    });

    for (const status of [204, 205]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => makeResponse({ status, json: jsonBomb, text: textBomb })),
      );
      const res = await fetchJson("https://api.example.com/nocontent");
      expect(res.noContent).toBe(true);
      expect(res.status).toBe(status);
      expect(res.data).toBeUndefined();
    }

    // 304 with allowNotModified: true resolves without parsing body
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        makeResponse({
          status: 304,
          headers: { ETag: '"v2"' },
          json: jsonBomb,
          text: textBomb,
        }),
      ),
    );
    const res304 = await fetchJson("https://api.example.com/cached", { allowNotModified: true });
    expect(res304.noContent).toBe(true);
    expect(res304.status).toBe(304);
    expect(res304.headers.get("etag")).toBe('"v2"');

    // 304 with default allowNotModified: false throws http error without forcing JSON
    await expect(fetchJson("https://api.example.com/cached")).rejects.toSatisfy(
      (err: unknown) => isHttpError(err, "http") && (err as HttpError).status === 304,
    );

    // HEAD & Content-Length: 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        makeResponse({
          status: 200,
          headers: { "Content-Length": "0" },
          json: jsonBomb,
          text: textBomb,
        }),
      ),
    );
    const emptyLen = await fetchJson("https://api.example.com/empty");
    expect(emptyLen.noContent).toBe(true);

    const headRes = await fetchHttp("https://api.example.com/head", { method: "HEAD" });
    expect(headRes.noContent).toBe(true);

    expect(jsonBomb).not.toHaveBeenCalled();
    expect(textBomb).not.toHaveBeenCalled();
  });

  it("supports fetchText for text/HTML payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        makeResponse({
          status: 200,
          text: async () => "<html>ok</html>",
        }),
      ),
    );
    const res = await fetchText("https://example.com/page");
    expect(res.noContent).toBe(false);
    expect(res.data).toBe("<html>ok</html>");
  });
});
