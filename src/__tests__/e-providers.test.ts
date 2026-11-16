import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsBag, WidgetContext, WidgetInstance } from "../core/types";
import githubWidget, { parseLastPage } from "../widgets/analytics/github-activity.widget";
import gmailWidget from "../widgets/online/gmail-unread.widget";
import hnWidget from "../widgets/online/hackernews-top.widget";
import instagramWidget from "../widgets/social/instagram-followers.widget";
import stockWidget from "../widgets/stocks/stock-quote.widget";

function makeCtx(
  initialSettings: SettingsBag = {},
  initialSecret: string | null = null,
  extra: Partial<WidgetContext> = {},
) {
  const settings: SettingsBag = { ...initialSettings };
  const listeners = new Set<(s: SettingsBag) => void>();
  let secret = initialSecret;
  const emit = () => {
    const snap = { ...settings };
    for (const fn of listeners) fn(snap);
  };
  const setSettings = vi.fn((patch: SettingsBag) => {
    Object.assign(settings, patch);
    emit();
  });
  const ctx: WidgetContext = {
    uid: "e-prov-uid",
    settings,
    invoke: vi.fn(async () => {
      throw new Error("no command");
    }),
    setSettings,
    onSettings: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    getSecret: vi.fn(async () => secret),
    setSecret: vi.fn(async (_k, v) => {
      secret = v;
    }),
    deleteSecret: vi.fn(async () => {
      secret = null;
    }),
    ...extra,
  };
  return {
    ctx,
    settings,
    emitSettings: (next: SettingsBag) => {
      for (const k of Object.keys(settings)) delete settings[k];
      Object.assign(settings, next);
      emit();
    },
  };
}

function jsonRes(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const status = init.status ?? 200;
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(init.headers ?? {})) {
    lower[k.toLowerCase()] = v;
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => lower[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function slowBodyRes(status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => new Promise(() => {}),
    text: () => new Promise(() => {}),
  } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (window as unknown as Record<string, unknown>).__TAURI__;
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("gmail-unread provider hardening", () => {
  it("cold starts with stored token, coalesces refreshes, handles 401 stop-polling + draft preservation, 429 backoff, 304, slow-body timeout, and destroy/signal abort", async () => {
    vi.useFakeTimers();

    // 1. Cold start + coalescing + 304 + 429 + slow-body timeout
    const first = deferred<Response>();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        calls += 1;
        return first.promise;
      }),
    );

    const body = document.createElement("div");
    const { ctx } = makeCtx({}, "ya29.initial");
    const inst = await gmailWidget.mount(body, ctx);

    expect(body.querySelector("[data-count]")?.textContent).toBe("…");
    const r1 = inst.refresh!();
    const r2 = inst.refresh!();
    expect(calls).toBe(1);

    first.resolve(jsonRes({ messagesUnread: 19 }));
    await Promise.all([r1, r2]);
    expect(body.querySelector("[data-count]")?.textContent).toBe("19");

    // 304 Not Modified must not fail JSON decode
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes(null, { status: 304 })));
    await inst.refresh!();
    expect(body.querySelector("[data-label]")?.textContent).toBe("inbox");

    // 429 Retry-After suppresses requests during cooldown
    calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return jsonRes({}, { status: 429, headers: { "Retry-After": "25" } });
      }),
    );
    await inst.refresh!();
    expect(calls).toBe(1);
    expect(body.querySelector("[data-label]")?.textContent).toBe("rate limited");

    await vi.advanceTimersByTimeAsync(10_000);
    await inst.refresh!();
    expect(calls).toBe(1);

    // After cooldown expires, slow-body timeout fires at 10s
    await vi.advanceTimersByTimeAsync(15_000);
    vi.stubGlobal("fetch", vi.fn(async () => slowBodyRes(200)));
    const slowP = inst.refresh!();
    await vi.advanceTimersByTimeAsync(10_000);
    await slowP;
    expect(body.querySelector("[data-label]")?.textContent).toBe("timeout");

    // 403 reports auth status
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({}, { status: 403 })));
    await inst.refresh!();
    expect(body.querySelector("[data-label]")?.textContent).toBe("auth 403");

    // 401 switches to reconnect form, stops polling across refresh cycles, and preserves user draft text
    calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return jsonRes({}, { status: 401 });
      }),
    );
    await inst.refresh!();
    expect(calls).toBe(1);
    const tokenInput = body.querySelector<HTMLInputElement>("[data-token]")!;
    expect(tokenInput).toBeTruthy();
    tokenInput.value = "ya29.user-draft";

    // Wait a full refresh period and invoke refresh repeatedly -> NO refetch, draft preserved
    await vi.advanceTimersByTimeAsync(120_000);
    await inst.refresh!();
    expect(calls).toBe(1);
    expect(body.querySelector<HTMLInputElement>("[data-token]")?.value).toBe("ya29.user-draft");

    // Saving a new token resumes polling
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({ messagesUnread: 7 })));
    body.querySelector<HTMLButtonElement>("[data-save]")!.click();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(body.querySelector("[data-count]")?.textContent).toBe("7"));

    // ctx.signal abort cancels in-flight request
    const ac = new AbortController();
    const hanging = deferred<Response>();
    let capturedSig: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_u: unknown, init?: RequestInit) => {
        capturedSig = init?.signal;
        return hanging.promise;
      }),
    );
    const body2 = document.createElement("div");
    const ctx2 = makeCtx({}, "ya29.tok2", { signal: ac.signal }).ctx;
    const inst2 = await gmailWidget.mount(body2, ctx2);
    expect(capturedSig?.aborted).toBe(false);
    ac.abort();
    expect(capturedSig?.aborted).toBe(true);
    hanging.resolve(jsonRes({ messagesUnread: 99 }));
    await Promise.resolve();
    expect(body2.querySelector("[data-count]")?.textContent).toBe("…");

    inst.destroy?.();
    inst2.destroy?.();
  });
});

describe("github-activity Link parser and lifecycle hardening", () => {
  it("parses rel=last page via URL+searchParams regardless of param order, link order, or invalid inputs", () => {
    expect(
      parseLastPage('<https://api.github.com/notifications?per_page=1&page=17>; rel="last"'),
    ).toBe(17);
    expect(
      parseLastPage('<https://api.github.com/notifications?page=17&per_page=1>; rel="last"'),
    ).toBe(17);
    expect(
      parseLastPage(
        '<https://api.github.com/notifications?per_page=1&page=2>; rel="next", ' +
          '<https://api.github.com/notifications?per_page=1&page=42>; rel="last", ' +
          '<https://api.github.com/notifications?per_page=1&page=1>; rel="first"',
      ),
    ).toBe(42);
    expect(parseLastPage('<https://api.github.com/notifications?per_page=1&page=2>; rel="next"')).toBeNull();
    expect(parseLastPage('<https://api.github.com/notifications?per_page=1&page=0>; rel="last"')).toBeNull();
    expect(parseLastPage('<https://api.github.com/notifications?per_page=1&page=-3>; rel="last"')).toBeNull();
    expect(parseLastPage('<https://api.github.com/notifications?per_page=1&page=abc>; rel="last"')).toBeNull();
    expect(parseLastPage('<https://api.github.com/notifications?per_page=1&page=1.5>; rel="last"')).toBeNull();
    expect(
      parseLastPage('<https://api.github.com/notifications?page=9007199254740992>; rel="last"'),
    ).toBeNull();
    expect(parseLastPage('<not a valid url:///>; rel="last"')).toBeNull();
    expect(parseLastPage(null)).toBeNull();
  });

  it("handles per_page=1&page=17, coalesces refreshes, handles 401 reconnect, 429 backoff, slow-body timeout, and destroy abort", async () => {
    vi.useFakeTimers();

    const dUser = deferred<Response>();
    const dNotif = deferred<Response>();
    let userCalls = 0;
    let notifCalls = 0;
    let capturedSignal: AbortSignal | null | undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown, init?: RequestInit) => {
        capturedSignal = init?.signal;
        const u = String(url);
        if (u.includes("/user")) {
          userCalls += 1;
          return dUser.promise;
        }
        notifCalls += 1;
        return dNotif.promise;
      }),
    );

    const body = document.createElement("div");
    const { ctx } = makeCtx({}, "ghp_1");
    const inst = await githubWidget.mount(body, ctx);

    const r1 = inst.refresh!();
    const r2 = inst.refresh!();
    expect(userCalls).toBe(1);
    expect(notifCalls).toBe(1);

    dUser.resolve(jsonRes({ login: "octocat" }));
    dNotif.resolve(
      jsonRes([{ id: "1" }], {
        headers: {
          Link: '<https://api.github.com/notifications?per_page=1&page=2>; rel="next", <https://api.github.com/notifications?per_page=1&page=17>; rel="last"',
        },
      }),
    );
    await Promise.all([r1, r2]);
    expect(body.querySelector("[data-count]")?.textContent).toBe("17");
    expect(body.querySelector("[data-login]")?.textContent).toBe("octocat");

    // 429 Retry-After backoff
    userCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        userCalls += 1;
        return jsonRes({}, { status: 429, headers: { "Retry-After": "15" } });
      }),
    );
    await inst.refresh!();
    expect(userCalls).toBe(2); // user + notifications in initial Promise.all
    expect(body.querySelector("[data-login]")?.textContent).toBe("rate limited");
    await inst.refresh!();
    expect(userCalls).toBe(2);

    // Slow body timeout after cooldown
    await vi.advanceTimersByTimeAsync(15_000);
    vi.stubGlobal("fetch", vi.fn(async () => slowBodyRes(200)));
    const slowP = inst.refresh!();
    await vi.advanceTimersByTimeAsync(10_000);
    await slowP;
    expect(body.querySelector("[data-login]")?.textContent).toBe("timeout");

    // 401 returns to reconnect form, stops polling, preserves draft, and resumes on save
    let calls401 = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls401 += 1;
        return jsonRes({}, { status: 401 });
      }),
    );
    await inst.refresh!();
    const countAfter401 = calls401;
    const tokenInput = body.querySelector<HTMLInputElement>("[data-token]")!;
    expect(tokenInput).toBeTruthy();
    tokenInput.value = "ghp_replacement";
    await inst.refresh!();
    expect(calls401).toBe(countAfter401);
    expect(body.querySelector<HTMLInputElement>("[data-token]")?.value).toBe("ghp_replacement");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) =>
        String(url).includes("/user") ? jsonRes({ login: "hubot" }) : jsonRes([]),
      ),
    );
    body.querySelector<HTMLButtonElement>("[data-save]")!.click();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(body.querySelector("[data-login]")?.textContent).toBe("hubot"));

    // Destroy aborts in-flight fetch
    const hanging = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn((_u: unknown, init?: RequestInit) => {
        capturedSignal = init?.signal;
        return hanging.promise;
      }),
    );
    void inst.refresh!();
    expect(capturedSignal?.aborted).toBe(false);
    inst.destroy?.();
    expect(capturedSignal?.aborted).toBe(true);
  });
});

describe("stock-quote generation, coalescing, A->B, 401/429 and timeout", () => {
  it("coalesces without discarding in-flight result, guards A->B stale success & stale 401, handles 401/429/timeout/destroy", async () => {
    vi.useFakeTimers();

    // 1. Concurrent refresh coalesces and does NOT increment generation before guard
    const aaplD = deferred<Response>();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        calls += 1;
        return aaplD.promise;
      }),
    );

    const body = document.createElement("div");
    const { ctx, emitSettings } = makeCtx({ symbol: "AAPL" }, "fh_1");
    const inst = await stockWidget.mount(body, ctx);

    const r1 = inst.refresh!();
    const r2 = inst.refresh!();
    expect(calls).toBe(1);
    aaplD.resolve(jsonRes({ c: 210.5, dp: 1.5, h: 212, l: 208 }));
    await Promise.all([r1, r2]);
    expect(body.querySelector("[data-price]")?.textContent).toBe("$210.50");

    // 2. A -> B switch aborts A and ignores late A success AND late A 401
    vi.useRealTimers();
    const staleSuccess = deferred<Response>();
    let sigA: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("symbol=AAPL")) {
          sigA = init?.signal;
          return staleSuccess.promise;
        }
        return Promise.resolve(jsonRes({ c: 420.0, dp: 2.0, h: 425, l: 415 }));
      }),
    );

    void inst.refresh!();
    emitSettings({ symbol: "MSFT" });
    expect(sigA?.aborted).toBe(true);
    await vi.waitFor(() => expect(body.querySelector("[data-price]")?.textContent).toBe("$420.00"));

    staleSuccess.resolve(jsonRes({ c: 1.11, dp: -9.0, h: 2, l: 1 }));
    await Promise.resolve();
    await Promise.resolve();
    expect(body.querySelector("[data-price]")?.textContent).toBe("$420.00");

    // Late A 401 must not kick B back to connect form
    const stale401 = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown) => {
        if (String(url).includes("symbol=MSFT")) return stale401.promise;
        return Promise.resolve(jsonRes({ c: 300.25, dp: 0.5, h: 302, l: 299 }));
      }),
    );
    void inst.refresh!();
    emitSettings({ symbol: "NVDA" });
    await vi.waitFor(() => expect(body.querySelector("[data-price]")?.textContent).toBe("$300.25"));
    stale401.resolve(jsonRes({}, { status: 401 }));
    await Promise.resolve();
    await Promise.resolve();
    expect(body.querySelector("[data-price]")?.textContent).toBe("$300.25");

    // 3. 429 backoff + slow body timeout + current 401 reconnect
    vi.useFakeTimers();
    let count429 = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        count429 += 1;
        return jsonRes({}, { status: 429, headers: { "Retry-After": "10" } });
      }),
    );
    await inst.refresh!();
    expect(count429).toBe(1);
    expect(body.querySelector("[data-chg]")?.textContent).toBe("rate limited");
    await inst.refresh!();
    expect(count429).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);
    vi.stubGlobal("fetch", vi.fn(async () => slowBodyRes(200)));
    const slowP = inst.refresh!();
    await vi.advanceTimersByTimeAsync(10_000);
    await slowP;
    expect(body.querySelector("[data-chg]")?.textContent).toBe("timeout");

    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({}, { status: 401 })));
    await inst.refresh!();
    const keyInput = body.querySelector<HTMLInputElement>("[data-key-input]")!;
    expect(keyInput).toBeTruthy();
    keyInput.value = "fh_new";
    await inst.refresh!();
    expect(body.querySelector<HTMLInputElement>("[data-key-input]")?.value).toBe("fh_new");

    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({ c: 500, dp: 1, h: 505, l: 495 })));
    body.querySelector<HTMLButtonElement>("[data-save]")!.click();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(body.querySelector("[data-price]")?.textContent).toBe("$500.00"));

    // Destroy aborts in-flight fetch
    let finalSig: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_u: unknown, init?: RequestInit) => {
        finalSig = init?.signal;
        return new Promise<Response>(() => {});
      }),
    );
    void inst.refresh!();
    expect(finalSig?.aborted).toBe(false);
    inst.destroy?.();
    expect(finalSig?.aborted).toBe(true);
  });
});

describe("instagram-followers A->B, coalescing, 401/429, timeout and destroy", () => {
  it("handles A->B config switch without dropping B, guards stale A success/401, coalesces, and honors 429/timeout/destroy", async () => {
    const aliceD = deferred<Response>();
    let sigA: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/111?")) {
          sigA = init?.signal;
          return aliceD.promise;
        }
        if (u.includes("/222?")) {
          return Promise.resolve(jsonRes({ followers_count: 2400, username: "bob" }));
        }
        return Promise.resolve(jsonRes({}, { status: 404 }));
      }),
    );

    const body = document.createElement("div");
    const { ctx, emitSettings } = makeCtx({ userId: "111" }, "ig_tok");
    const inst = await instagramWidget.mount(body, ctx);

    // Switch A -> B while A is pending
    emitSettings({ userId: "222" });
    expect(sigA?.aborted).toBe(true);
    await vi.waitFor(() => expect(body.querySelector("[data-count]")?.textContent).toBe("2.4K"));
    expect(body.querySelector("[data-user]")?.textContent).toBe("@bob");

    // Late A success must not overwrite B
    aliceD.resolve(jsonRes({ followers_count: 999_000, username: "alice" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(body.querySelector("[data-count]")?.textContent).toBe("2.4K");
    expect(body.querySelector("[data-user]")?.textContent).toBe("@bob");

    // Late A 401 must not force B back to connect form
    const stale401 = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown) => {
        if (String(url).includes("/222?")) return stale401.promise;
        return Promise.resolve(jsonRes({ followers_count: 350, username: "carol" }));
      }),
    );
    void inst.refresh!();
    emitSettings({ userId: "333" });
    await vi.waitFor(() => expect(body.querySelector("[data-count]")?.textContent).toBe("350"));
    stale401.resolve(jsonRes({}, { status: 401 }));
    await Promise.resolve();
    await Promise.resolve();
    expect(body.querySelector("[data-count]")?.textContent).toBe("350");

    // Coalesce + 429 + timeout + 401 reconnect + destroy
    vi.useFakeTimers();
    let calls = 0;
    const d429 = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        calls += 1;
        return d429.promise;
      }),
    );
    const p1 = inst.refresh!();
    const p2 = inst.refresh!();
    expect(calls).toBe(1);
    d429.resolve(jsonRes({}, { status: 429, headers: { "Retry-After": "12" } }));
    await Promise.all([p1, p2]);
    expect(body.querySelector("[data-note]")?.textContent).toBe("rate limited");
    await inst.refresh!();
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(12_000);
    vi.stubGlobal("fetch", vi.fn(async () => slowBodyRes(200)));
    const slowP = inst.refresh!();
    await vi.advanceTimersByTimeAsync(8_000);
    await slowP;
    expect(body.querySelector("[data-note]")?.textContent).toBe("timeout");

    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({}, { status: 401 })));
    await inst.refresh!();
    const tokIn = body.querySelector<HTMLInputElement>("[data-token]")!;
    expect(tokIn).toBeTruthy();
    tokIn.value = "ig_draft";
    await inst.refresh!();
    expect(body.querySelector<HTMLInputElement>("[data-token]")?.value).toBe("ig_draft");

    let destroySig: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_u: unknown, init?: RequestInit) => {
        destroySig = init?.signal;
        return new Promise<Response>(() => {});
      }),
    );
    body.querySelector<HTMLButtonElement>("[data-save]")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(destroySig?.aborted).toBe(false);
    inst.destroy?.();
    expect(destroySig?.aborted).toBe(true);
  });
});

describe("hackernews-top background first round, abort, coalescing, 429/timeout and B4 open_web_url", () => {
  it("returns instance synchronously before first round settles, aborts on destroy/signal, coalesces, and handles 429/timeout", async () => {
    vi.useFakeTimers();

    const first = deferred<Response>();
    let capturedSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_u: unknown, init?: RequestInit) => {
        capturedSignal = init?.signal;
        return first.promise;
      }),
    );

    const body = document.createElement("div");
    const { ctx } = makeCtx();
    const mountRes = hnWidget.mount(body, ctx);
    expect(mountRes).not.toBeInstanceOf(Promise);
    const inst = mountRes as WidgetInstance;
    expect(capturedSignal?.aborted).toBe(false);

    // Coalescing during pending first round
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        calls += 1;
        return first.promise;
      }),
    );
    void inst.refresh!();
    expect(calls).toBe(0);

    // Destroy aborts first round and ignores late resolution
    inst.destroy!();
    expect(capturedSignal?.aborted).toBe(true);
    first.resolve(jsonRes([1]));
    await Promise.resolve();
    expect(body.querySelector("[data-list]")?.textContent).toContain("loading…");

    // 429 backoff + slow-body timeout + ctx.signal abort
    const ac = new AbortController();
    let count429 = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        count429 += 1;
        return jsonRes({}, { status: 429, headers: { "Retry-After": "20" } });
      }),
    );
    const body2 = document.createElement("div");
    const inst2 = hnWidget.mount(body2, makeCtx({}, null, { signal: ac.signal }).ctx) as WidgetInstance;
    await vi.advanceTimersByTimeAsync(0);
    expect(count429).toBe(1);
    expect(body2.querySelector("[data-list]")?.textContent).toBe("rate limited");
    await inst2.refresh!();
    expect(count429).toBe(1);

    await vi.advanceTimersByTimeAsync(20_000);
    vi.stubGlobal("fetch", vi.fn(async () => slowBodyRes(200)));
    const slowP = inst2.refresh!();
    await vi.advanceTimersByTimeAsync(10_000);
    await slowP;
    expect(body2.querySelector("[data-list]")?.textContent).toBe("timeout");

    vi.stubGlobal(
      "fetch",
      vi.fn((_u: unknown, init?: RequestInit) => {
        capturedSignal = init?.signal;
        return new Promise<Response>(() => {});
      }),
    );
    void inst2.refresh!();
    expect(capturedSignal?.aborted).toBe(false);
    ac.abort();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("preserves B4 open_web_url wiring and never falls back to window.open inside Tauri", async () => {
    (window as unknown as Record<string, unknown>).__TAURI__ = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const u = String(url);
        if (u.includes("topstories")) return jsonRes([1, 2]);
        if (u.includes("item/1")) {
          return jsonRes({ id: 1, title: "Safe", url: "https://example.com/a", score: 10 });
        }
        return jsonRes({ id: 2, title: "Unsafe", url: "javascript:alert(1)", score: 5 });
      }),
    );
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);
    const invokeSpy = vi.fn(async () => {
      throw new Error("rejected");
    });

    const body = document.createElement("div");
    const inst = hnWidget.mount(body, makeCtx({}, null, { invoke: invokeSpy }).ctx) as WidgetInstance;
    await vi.waitFor(() => expect(body.querySelectorAll("[data-url]").length).toBe(2));

    const links = [...body.querySelectorAll<HTMLElement>("[data-url]")];
    expect(links.map((l) => l.dataset.url)).toEqual([
      "https://example.com/a",
      "https://news.ycombinator.com/item?id=2",
    ]);

    links[0].click();
    await vi.waitFor(() =>
      expect(invokeSpy).toHaveBeenCalledWith("open_web_url", { url: "https://example.com/a" }),
    );
    expect(openSpy).not.toHaveBeenCalled();
    inst.destroy?.();
  });
});
