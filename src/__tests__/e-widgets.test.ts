import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsBag, WidgetContext, WidgetInstance } from "../core/types";
import stackoverflowWidget from "../widgets/analytics/stackoverflow-rep.widget";
import tiktokWidget from "../widgets/social/tiktok-profile.widget";
import weatherCurrentWidget from "../widgets/weather/weather-current.widget";
import weatherForecastWidget from "../widgets/weather/weather-forecast.widget";

function makeCtx(initialSettings: SettingsBag = {}) {
  const settings: SettingsBag = { ...initialSettings };
  const listeners = new Set<(s: SettingsBag) => void>();
  const emit = () => {
    const snap = { ...settings };
    for (const fn of listeners) fn(snap);
  };
  const setSettings = vi.fn((patch: SettingsBag) => {
    Object.assign(settings, patch);
    emit();
  });
  const ctx: WidgetContext = {
    uid: "e-test-uid",
    settings,
    invoke: vi.fn(async () => {
      throw new Error("no command");
    }),
    setSettings,
    onSettings: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    setSecret: vi.fn(async () => {}),
    getSecret: vi.fn(async () => null),
    deleteSecret: vi.fn(async () => {}),
  };
  return {
    ctx,
    settings,
    setSettings,
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
});

describe("tiktok-profile widget", () => {
  it("prevents stale A success and stale A 401 from overwriting B after A->B switch", async () => {
    const aliceDeferred = deferred<Response>();
    const aliceSignals: AbortSignal[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("uniqueId=alice")) {
          if (init?.signal) aliceSignals.push(init.signal);
          // Deliberately ignore AbortSignal to verify generation guard too
          return aliceDeferred.promise;
        }
        if (u.includes("uniqueId=bob")) {
          return Promise.resolve(
            jsonRes({
              userInfo: { stats: { followerCount: 2400, followingCount: 15, heartCount: 9500 } },
            }),
          );
        }
        return Promise.resolve(jsonRes({}, { status: 404 }));
      }),
    );

    const body = document.createElement("div");
    const { ctx, emitSettings } = makeCtx({ username: "alice" });
    const inst = tiktokWidget.mount(body, ctx) as WidgetInstance;

    expect(body.querySelector("[data-user]")?.textContent).toBe("@alice");

    // Switch A -> B while Alice's request is still pending
    emitSettings({ username: "bob" });
    expect(aliceSignals[0]?.aborted).toBe(true);
    expect(body.querySelector("[data-user]")?.textContent).toBe("@bob");

    await vi.waitFor(() => {
      expect(body.querySelector("[data-followers]")?.textContent).toBe("2.4K");
    });

    // Late arrival of Alice's success must NOT overwrite Bob's stats
    aliceDeferred.resolve(
      jsonRes({
        userInfo: { stats: { followerCount: 999_000, followingCount: 1, heartCount: 1 } },
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(body.querySelector("[data-user]")?.textContent).toBe("@bob");
    expect(body.querySelector("[data-followers]")?.textContent).toBe("2.4K");
    expect(body.querySelector("[data-note]")?.textContent).toBe("");
    inst.destroy?.();

    // Case 2: Late arrival of Alice's 401 failure after switching to Charlie
    const alice401Deferred = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown) => {
        const u = String(url);
        if (u.includes("uniqueId=alice")) return alice401Deferred.promise;
        if (u.includes("uniqueId=charlie")) {
          return Promise.resolve(
            jsonRes({
              userInfo: { stats: { followerCount: 510, followingCount: 10, heartCount: 800 } },
            }),
          );
        }
        return Promise.resolve(jsonRes({}, { status: 404 }));
      }),
    );

    const body2 = document.createElement("div");
    const ctx2 = makeCtx({ username: "alice" });
    const inst2 = tiktokWidget.mount(body2, ctx2.ctx) as WidgetInstance;
    ctx2.emitSettings({ username: "charlie" });

    await vi.waitFor(() => {
      expect(body2.querySelector("[data-followers]")?.textContent).toBe("510");
    });

    alice401Deferred.resolve(jsonRes({}, { status: 401 }));
    await Promise.resolve();
    await Promise.resolve();

    expect(body2.querySelector("[data-user]")?.textContent).toBe("@charlie");
    expect(body2.querySelector("[data-followers]")?.textContent).toBe("510");
    expect(body2.querySelector("[data-note]")?.textContent).toBe("");
    inst2.destroy?.();
  });

  it("coalesces same-config refreshes, cancels on destroy, and honors 429 Retry-After & slow-body timeout", async () => {
    vi.useFakeTimers();
    const d1 = deferred<Response>();
    let calls = 0;
    let lastSignal: AbortSignal | null | undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn((_url: unknown, init?: RequestInit) => {
        calls += 1;
        lastSignal = init?.signal;
        return d1.promise;
      }),
    );

    const body = document.createElement("div");
    const { ctx } = makeCtx({ username: "alice" });
    const inst = tiktokWidget.mount(body, ctx) as WidgetInstance;

    // Initial mount started 1 request; concurrent refreshes for same username coalesce
    const r1 = inst.refresh!();
    const r2 = inst.refresh!();
    expect(calls).toBe(1);

    d1.resolve(
      jsonRes({
        userInfo: { stats: { followerCount: 1200, followingCount: 20, heartCount: 3400 } },
      }),
    );
    await Promise.all([r1, r2]);
    expect(body.querySelector("[data-followers]")?.textContent).toBe("1.2K");

    // 429 Retry-After stops trying fallback endpoints and suppresses retries during cooldown
    calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return jsonRes({}, { status: 429, headers: { "Retry-After": "30" } });
      }),
    );
    await inst.refresh!();
    expect(calls).toBe(1); // stopped immediately on 429 without hammering other 2 URLs
    expect(body.querySelector("[data-note]")?.textContent).toBe("rate limited");

    // Refresh within 30s cooldown does not hit network
    await vi.advanceTimersByTimeAsync(15_000);
    await inst.refresh!();
    expect(calls).toBe(1);

    // After 30s cooldown, network call is allowed again; test slow-body timeout + destroy abort
    await vi.advanceTimersByTimeAsync(15_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        lastSignal = init?.signal;
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: () => new Promise(() => {}),
          text: () => new Promise(() => {}),
        } as unknown as Response;
      }),
    );
    const slowRefresh = inst.refresh!();
    await vi.advanceTimersByTimeAsync(21_000); // 3 endpoints x 7000ms
    await slowRefresh;
    expect(body.querySelector("[data-followers]")?.textContent).toBe("–");
    expect(body.querySelector("[data-note]")?.textContent).toBe("connect");

    // Destroy aborts in-flight request
    const hanging = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: unknown, init?: RequestInit) => {
        lastSignal = init?.signal;
        return hanging.promise;
      }),
    );
    void inst.refresh!();
    expect(lastSignal?.aborted).toBe(false);
    inst.destroy?.();
    expect(lastSignal?.aborted).toBe(true);

    // Late resolution after destroy must not mutate DOM
    body.querySelector<HTMLElement>("[data-followers]")!.textContent = "SENTINEL";
    hanging.resolve(
      jsonRes({ userInfo: { stats: { followerCount: 5000, followingCount: 1, heartCount: 1 } } }),
    );
    await Promise.resolve();
    expect(body.querySelector("[data-followers]")?.textContent).toBe("SENTINEL");

    // Current 401 shows auth status and switching to empty username cancels pending job
    const body3 = document.createElement("div");
    const ctx3 = makeCtx({ username: "alice" });
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({}, { status: 401 })));
    const inst3 = tiktokWidget.mount(body3, ctx3.ctx) as WidgetInstance;
    await vi.advanceTimersByTimeAsync(0);
    expect(body3.querySelector("[data-note]")?.textContent).toBe("auth 401");

    const pendingA = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => pendingA.promise));
    void inst3.refresh!();
    ctx3.emitSettings({ username: "" }); // switches to connect view
    expect(body3.querySelector("[data-username]")).not.toBeNull();
    pendingA.resolve(
      jsonRes({ userInfo: { stats: { followerCount: 777, followingCount: 1, heartCount: 1 } } }),
    );
    await Promise.resolve();
    expect(body3.querySelector("[data-username]")).not.toBeNull();
    inst3.destroy?.();
  });
});

describe("stackoverflow-rep widget", () => {
  it("uses bounded fetchJson (timeout on slow body), handles 204/401/429, coalesces & guards stale A->B", async () => {
    vi.useFakeTimers();

    // 1. Slow body triggers timeout -> "timeout"
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: () => new Promise(() => {}),
      })),
    );
    const body = document.createElement("div");
    const { ctx, emitSettings } = makeCtx({ userId: "100" });
    const inst = stackoverflowWidget.mount(body, ctx) as WidgetInstance;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(body.querySelector("[data-name]")?.textContent).toBe("timeout");

    // 2. Coalesce same-config refresh & handle 429 Retry-After
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
    d429.resolve(jsonRes({}, { status: 429, headers: { "Retry-After": "20" } }));
    await Promise.all([p1, p2]);
    expect(body.querySelector("[data-name]")?.textContent).toBe("rate limited");

    // Within cooldown -> no fetch
    await inst.refresh!();
    expect(calls).toBe(1);

    // 3. Switching A -> B resets cooldown, aborts stale A, and ignores stale A resolution
    vi.useRealTimers();
    const staleUser = deferred<Response>();
    let signalA: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/users/200")) {
          signalA = init?.signal;
          return staleUser.promise;
        }
        if (u.includes("/users/300")) {
          return Promise.resolve(
            jsonRes({
              items: [
                {
                  display_name: "Ada",
                  reputation: 9_500,
                  badge_counts: { gold: 2, silver: 5, bronze: 9 },
                },
              ],
            }),
          );
        }
        return Promise.resolve(jsonRes({}, { status: 204 }));
      }),
    );

    emitSettings({ userId: "200" });
    emitSettings({ userId: "300" });
    expect(signalA?.aborted).toBe(true);

    await vi.waitFor(() => {
      expect(body.querySelector("[data-rep]")?.textContent).toBe("9.5k");
      expect(body.querySelector("[data-name]")?.textContent).toBe("Ada");
    });

    // Late 200 from user 200 must not overwrite user 300
    staleUser.resolve(
      jsonRes({
        items: [{ display_name: "Stale", reputation: 1, badge_counts: { gold: 0 } }],
      }),
    );
    await Promise.resolve();
    expect(body.querySelector("[data-name]")?.textContent).toBe("Ada");

    // 4. 204 No Content & 401 Auth
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes(null, { status: 204 })));
    await inst.refresh!();
    expect(body.querySelector("[data-name]")?.textContent).toBe("not found");

    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({}, { status: 401 })));
    await inst.refresh!();
    expect(body.querySelector("[data-name]")?.textContent).toBe("auth 401");

    inst.destroy?.();
  });
});

describe("weather widgets (background first refresh, destroy, generation control, bounded fetch)", () => {
  it("weather-current returns instance immediately before first fetch settles and destroys cleanly", async () => {
    const firstFetch = deferred<Response>();
    let capturedSignal: AbortSignal | null | undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn((_url: unknown, init?: RequestInit) => {
        capturedSignal = init?.signal;
        return firstFetch.promise;
      }),
    );

    const body = document.createElement("div");
    const { ctx } = makeCtx();
    const mountResult = weatherCurrentWidget.mount(body, ctx);

    // Must return WidgetInstance synchronously, NOT a Promise waiting on network
    expect(mountResult).not.toBeInstanceOf(Promise);
    const inst = mountResult as WidgetInstance;
    expect(typeof inst.destroy).toBe("function");
    expect(capturedSignal?.aborted).toBe(false);

    // Destroy before first background request completes
    inst.destroy!();
    expect(capturedSignal?.aborted).toBe(true);

    // Late response after destroy must not populate temperature
    firstFetch.resolve(
      jsonRes({
        current: { temperature_2m: 25, weather_code: 0, is_day: 1, wind_speed_10m: 10 },
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(body.querySelector("[data-temp]")?.textContent).toBe("–");
  });

  it("weather-current enforces generation guard on A->B switch and bounded body timeout", async () => {
    vi.useFakeTimers();
    const londonDeferred = deferred<Response>();

    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown) => {
        const u = String(url);
        if (u.includes("latitude=51.5074")) return londonDeferred.promise;
        return Promise.resolve(
          jsonRes({
            current: { temperature_2m: 28, weather_code: 0, is_day: 1, wind_speed_10m: 8 },
            daily: { temperature_2m_max: [30], temperature_2m_min: [20] },
          }),
        );
      }),
    );

    const body = document.createElement("div");
    const { ctx, emitSettings } = makeCtx();
    const inst = weatherCurrentWidget.mount(body, ctx) as WidgetInstance;

    emitSettings({ location: { lat: 35.6762, lon: 139.6503, label: "Tokyo" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(body.querySelector("[data-temp]")?.textContent).toBe("28°");
    expect(body.querySelector("[data-cond]")?.textContent).toContain("Tokyo");

    // Stale London response arrives late -> must NOT overwrite Tokyo
    londonDeferred.resolve(
      jsonRes({
        current: { temperature_2m: 5, weather_code: 63, is_day: 1, wind_speed_10m: 20 },
      }),
    );
    await Promise.resolve();
    expect(body.querySelector("[data-temp]")?.textContent).toBe("28°");
    expect(body.querySelector("[data-cond]")?.textContent).toContain("Tokyo");

    // Slow body after headers arrived triggers 12000ms timeout
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: () => new Promise(() => {}),
      })),
    );
    const p = inst.refresh!();
    await vi.advanceTimersByTimeAsync(12_000);
    await p;
    expect(body.querySelector("[data-cond]")?.textContent).toBe("Timed out");

    // 204 no-content, 401 auth, and malformed JSON decode errors
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes(null, { status: 204 })));
    await inst.refresh!();
    expect(body.querySelector("[data-cond]")?.textContent).toBe("Invalid data");

    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({}, { status: 401 })));
    await inst.refresh!();
    expect(body.querySelector("[data-cond]")?.textContent).toBe("Auth 401");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => {
          throw new SyntaxError("bad json");
        },
      })),
    );
    await inst.refresh!();
    expect(body.querySelector("[data-cond]")?.textContent).toBe("Invalid data");

    inst.destroy?.();
  });

  it("weather-forecast returns instance immediately, aborts on destroy, and enforces generation & Retry-After", async () => {
    vi.useFakeTimers();
    const londonDeferred = deferred<Response>();
    let londonSignal: AbortSignal | null | undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("latitude=51.5074")) {
          londonSignal = init?.signal;
          return londonDeferred.promise;
        }
        return Promise.resolve(
          jsonRes({
            daily: {
              time: ["2026-11-16", "2026-11-17"],
              temperature_2m_max: [22, 24],
              temperature_2m_min: [12, 14],
              weather_code: [0, 2],
            },
          }),
        );
      }),
    );

    const body = document.createElement("div");
    const { ctx, emitSettings } = makeCtx();
    const mountResult = weatherForecastWidget.mount(body, ctx);
    expect(mountResult).not.toBeInstanceOf(Promise);
    const inst = mountResult as WidgetInstance;

    // Switch London -> Paris while London is pending
    emitSettings({ location: { lat: 48.8566, lon: 2.3522, label: "Paris" } });
    expect(londonSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(body.querySelector("[data-loc]")?.textContent).toBe("Paris");

    // Stale London failure arrives late -> must NOT overwrite Paris forecast
    londonDeferred.reject(new TypeError("stale network fail"));
    await Promise.resolve();
    expect(body.querySelector("[data-loc]")?.textContent).toBe("Paris");
    expect(body.querySelector("[data-view]")?.textContent).toContain("Today");

    // 429 Retry-After suppresses subsequent refreshes during cooldown
    let rateCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        rateCalls += 1;
        return jsonRes({}, { status: 429, headers: { "Retry-After": "45" } });
      }),
    );
    await inst.refresh!();
    expect(rateCalls).toBe(1);
    expect(body.querySelector("[data-view]")?.textContent).toBe("Rate limited");

    await vi.advanceTimersByTimeAsync(20_000);
    await inst.refresh!();
    expect(rateCalls).toBe(1);

    // After cooldown: 403 auth, 204 no-content, and slow-body timeout
    await vi.advanceTimersByTimeAsync(25_000);
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({}, { status: 403 })));
    await inst.refresh!();
    expect(body.querySelector("[data-view]")?.textContent).toBe("Auth 403");

    vi.stubGlobal("fetch", vi.fn(async () => jsonRes(null, { status: 204 })));
    await inst.refresh!();
    expect(body.querySelector("[data-view]")?.textContent).toBe("Invalid data");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: () => new Promise(() => {}),
      })),
    );
    const timeoutRefresh = inst.refresh!();
    await vi.advanceTimersByTimeAsync(12_000);
    await timeoutRefresh;
    expect(body.querySelector("[data-view]")?.textContent).toBe("Timed out");

    inst.destroy?.();
  });
});
