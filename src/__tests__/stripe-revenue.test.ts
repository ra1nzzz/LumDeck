import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsBag, WidgetContext, WidgetInstance } from "../core/types";
import revenueWidget from "../widgets/finance/revenue.widget";

function makeCtx(
  initialSettings: SettingsBag = {},
  overrides: Partial<WidgetContext> = {},
) {
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
    uid: "stripe-test-uid",
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
    getSecret: vi.fn(async () => "sk_test_default"),
    deleteSecret: vi.fn(async () => {}),
    ...overrides,
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

describe("Stripe revenue widget (Plan E.5)", () => {
  it("computes amount_captured - amount_refunded (10000 auth, 6000 captured, 1000 refunded = 50 USD) and excludes invalid charges", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const fixture = [
      // Valid partial capture + partial refund: 6000 - 1000 = 5000 cents = 50 USD
      {
        id: "ch_valid",
        status: "succeeded",
        amount: 10_000,
        amount_captured: 6_000,
        amount_refunded: 1_000,
        currency: "usd",
        created: nowSec - 1200,
      },
      // Invalid: missing id
      {
        status: "succeeded",
        amount: 5_000,
        amount_captured: 5_000,
        amount_refunded: 0,
        currency: "usd",
        created: nowSec - 600,
      },
      // Invalid: missing amount_captured (must not fall back to amount)
      {
        id: "ch_no_captured",
        status: "succeeded",
        amount: 5_000,
        amount_refunded: 0,
        currency: "usd",
        created: nowSec - 600,
      },
      // Invalid: captured: false
      {
        id: "ch_uncaptured_flag",
        status: "succeeded",
        captured: false,
        amount: 5_000,
        amount_captured: 5_000,
        amount_refunded: 0,
        currency: "usd",
        created: nowSec - 600,
      },
      // Invalid: amount_refunded > amount_captured
      {
        id: "ch_refund_gt_captured",
        status: "succeeded",
        amount: 5_000,
        amount_captured: 2_000,
        amount_refunded: 3_000,
        currency: "usd",
        created: nowSec - 600,
      },
      // Invalid: negative amount_captured
      {
        id: "ch_neg_captured",
        status: "succeeded",
        amount_captured: -500,
        amount_refunded: 0,
        currency: "usd",
        created: nowSec - 600,
      },
      // Invalid: negative amount_refunded
      {
        id: "ch_neg_refund",
        status: "succeeded",
        amount: 5_000,
        amount_captured: 5_000,
        amount_refunded: -100,
        currency: "usd",
        created: nowSec - 600,
      },
      // Invalid: amount_captured > amount
      {
        id: "ch_captured_gt_amount",
        status: "succeeded",
        amount: 1_000,
        amount_captured: 2_000,
        amount_refunded: 0,
        currency: "usd",
        created: nowSec - 600,
      },
      // Invalid: non-numeric amount_captured
      {
        id: "ch_nan_captured",
        status: "succeeded",
        amount_captured: Number.NaN,
        amount_refunded: 0,
        currency: "usd",
        created: nowSec - 600,
      },
      // Invalid: bad currency
      {
        id: "ch_bad_currency",
        status: "succeeded",
        amount: 5_000,
        amount_captured: 5_000,
        amount_refunded: 0,
        currency: "12",
        created: nowSec - 600,
      },
      // Excluded: non-succeeded status
      {
        id: "ch_failed",
        status: "failed",
        amount: 5_000,
        amount_captured: 5_000,
        amount_refunded: 0,
        currency: "usd",
        created: nowSec - 600,
      },
      // Excluded: older than 30 days
      {
        id: "ch_old",
        status: "succeeded",
        amount: 5_000,
        amount_captured: 5_000,
        amount_refunded: 0,
        currency: "usd",
        created: nowSec - 31 * 86_400,
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes({ data: fixture, has_more: false })),
    );

    const body = document.createElement("div");
    const { ctx } = makeCtx();
    const inst = (await revenueWidget.mount(body, ctx)) as WidgetInstance;

    await vi.waitFor(() => {
      expect(body.querySelector("[data-total]")?.textContent).toContain("50");
    });
    expect(body.querySelector("[data-total]")?.getAttribute("title")).toContain("50 USD");
    expect(body.querySelector("[data-sub]")?.textContent).toContain("1 charge");
    expect(body.querySelector<HTMLElement>("[data-partial]")?.style.display).toBe("none");
    inst.destroy?.();
  });

  it("paginates 100+ charges with fixed created[gte] and starting_after cursor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
    const nowSec = Math.floor(Date.now() / 1000);
    const expectedCreatedGte = nowSec - 30 * 86_400;

    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: `ch_p1_${i + 1}`,
      status: "succeeded",
      amount: 100,
      amount_captured: 100,
      amount_refunded: 0,
      currency: "usd",
      created: nowSec - 100 - i,
    }));
    const page2 = Array.from({ length: 30 }, (_, i) => ({
      id: `ch_p2_${i + 1}`,
      status: "succeeded",
      amount: 200,
      amount_captured: 200,
      amount_refunded: 0,
      currency: "usd",
      created: nowSec - 5000 - i,
    }));

    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const u = String(url);
        requestedUrls.push(u);
        if (requestedUrls.length === 1) {
          // Advance wall clock between pages; created[gte] on page 2 must stay fixed
          vi.advanceTimersByTime(4_000);
          return jsonRes({ data: page1, has_more: true });
        }
        return jsonRes({ data: page2, has_more: false });
      }),
    );

    const body = document.createElement("div");
    const { ctx } = makeCtx();
    const inst = (await revenueWidget.mount(body, ctx)) as WidgetInstance;
    await vi.advanceTimersByTimeAsync(0);

    expect(requestedUrls).toHaveLength(2);
    const u1 = new URL(requestedUrls[0]);
    const u2 = new URL(requestedUrls[1]);
    expect(u1.searchParams.get("limit")).toBe("100");
    expect(u1.searchParams.get("created[gte]")).toBe(String(expectedCreatedGte));
    expect(u1.searchParams.get("starting_after")).toBeNull();

    expect(u2.searchParams.get("created[gte]")).toBe(String(expectedCreatedGte));
    expect(u2.searchParams.get("starting_after")).toBe("ch_p1_100");

    // 100 * 100 + 30 * 200 = 16000 cents = $160
    expect(body.querySelector("[data-total]")?.textContent).toContain("160");
    expect(body.querySelector("[data-sub]")?.textContent).toContain("130 charges");
    expect(body.querySelector<HTMLElement>("[data-partial]")?.style.display).toBe("none");
    inst.destroy?.();
  });

  it("stops on duplicate cursor and empty page with has_more=true without double-counting and marks result partial", async () => {
    const nowSec = Math.floor(Date.now() / 1000);

    // Case 1: duplicate cursor
    let dupCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        dupCalls += 1;
        if (dupCalls === 1) {
          return jsonRes({
            data: [
              { id: "ch_1", status: "succeeded", amount_captured: 1000, amount_refunded: 0, currency: "usd", created: nowSec - 60 },
              { id: "ch_2", status: "succeeded", amount_captured: 2000, amount_refunded: 0, currency: "usd", created: nowSec - 120 },
            ],
            has_more: true,
          });
        }
        // Returns overlapping item + repeats last cursor "ch_2" with has_more: true
        return jsonRes({
          data: [
            { id: "ch_3", status: "succeeded", amount_captured: 500, amount_refunded: 0, currency: "usd", created: nowSec - 180 },
            { id: "ch_2", status: "succeeded", amount_captured: 2000, amount_refunded: 0, currency: "usd", created: nowSec - 120 },
          ],
          has_more: true,
        });
      }),
    );

    const body = document.createElement("div");
    const { ctx } = makeCtx();
    const inst = (await revenueWidget.mount(body, ctx)) as WidgetInstance;

    await vi.waitFor(() => {
      expect(body.querySelector("[data-total]")?.textContent).toContain("35");
    });
    expect(dupCalls).toBe(2);
    expect(body.querySelector("[data-sub]")?.textContent).toContain("3 charges");
    expect(body.querySelector("[data-sub]")?.textContent?.toLowerCase()).toContain("partial");
    expect(body.querySelector<HTMLElement>("[data-partial]")?.style.display).not.toBe("none");
    expect(body.querySelector("[data-partial]")?.textContent).toBe("Partial");
    inst.destroy?.();

    // Case 2: empty page with has_more: true
    let emptyCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        emptyCalls += 1;
        if (emptyCalls === 1) {
          return jsonRes({
            data: [
              { id: "ch_a", status: "succeeded", amount_captured: 4000, amount_refunded: 0, currency: "usd", created: nowSec - 60 },
            ],
            has_more: true,
          });
        }
        return jsonRes({ data: [], has_more: true });
      }),
    );

    const body2 = document.createElement("div");
    const inst2 = (await revenueWidget.mount(body2, makeCtx().ctx)) as WidgetInstance;

    await vi.waitFor(() => {
      expect(body2.querySelector("[data-total]")?.textContent).toContain("40");
    });
    expect(emptyCalls).toBe(2);
    expect(body2.querySelector<HTMLElement>("[data-partial]")?.style.display).not.toBe("none");
    expect(body2.querySelector("[data-sub]")?.textContent?.toLowerCase()).toContain("partial");
    inst2.destroy?.();
  });

  it("enforces page cap and single-round budget and clearly marks partial totals", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
    const nowSec = Math.floor(Date.now() / 1000);

    // 1. Page limit (MAX_PAGES = 10)
    let pageIdx = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        pageIdx += 1;
        return jsonRes({
          data: [
            {
              id: `ch_pg_${pageIdx}`,
              status: "succeeded",
              amount_captured: 1000,
              amount_refunded: 0,
              currency: "usd",
              created: nowSec - pageIdx * 10,
            },
          ],
          has_more: true,
        });
      }),
    );

    const body1 = document.createElement("div");
    const inst1 = (await revenueWidget.mount(body1, makeCtx().ctx)) as WidgetInstance;
    await vi.advanceTimersByTimeAsync(0);

    expect(pageIdx).toBe(10);
    expect(body1.querySelector("[data-total]")?.textContent).toContain("100");
    expect(body1.querySelector<HTMLElement>("[data-partial]")?.style.display).not.toBe("none");
    expect(body1.querySelector("[data-sub]")?.textContent).toContain("page limit");
    inst1.destroy?.();

    // 2. Single-round time budget (20,000ms): pages 1 & 2 take 7s each, page 3 hangs -> partial after 20s
    let budgetPage = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: unknown, init?: RequestInit) => {
        budgetPage += 1;
        if (budgetPage <= 2) {
          return new Promise<Response>((resolve) => {
            setTimeout(() => {
              resolve(
                jsonRes({
                  data: [
                    {
                      id: `ch_b_${budgetPage}`,
                      status: "succeeded",
                      amount_captured: 2500,
                      amount_refunded: 0,
                      currency: "usd",
                      created: nowSec - budgetPage * 10,
                    },
                  ],
                  has_more: true,
                }),
              );
            }, 7_000);
          });
        }
        // Page 3 hangs until fetchJson's remaining budget timeout aborts it
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
      }),
    );

    const body2 = document.createElement("div");
    const inst2 = (await revenueWidget.mount(body2, makeCtx().ctx)) as WidgetInstance;
    await vi.advanceTimersByTimeAsync(20_000);

    expect(budgetPage).toBe(3);
    // 2 pages * $25 = $50 partial
    expect(body2.querySelector("[data-total]")?.textContent).toContain("50");
    expect(body2.querySelector<HTMLElement>("[data-partial]")?.style.display).not.toBe("none");
    expect(body2.querySelector("[data-sub]")?.textContent).toContain("budget");
    inst2.destroy?.();

    // 3. Page 1 slow-body timeout -> reports timeout error, NOT partial $0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: () => new Promise(() => {}),
      })),
    );

    const body3 = document.createElement("div");
    const inst3 = (await revenueWidget.mount(body3, makeCtx().ctx)) as WidgetInstance;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(body3.querySelector("[data-total]")?.textContent).toBe("–");
    expect(body3.querySelector("[data-msg]")?.textContent).toContain("timed out");
    inst3.destroy?.();
  });

  it("accumulates mixed USD/JPY independently without comparing minor units and requires explicit currency selection", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    // 5000 JPY minor units vs 3000 USD minor units ($30): must NOT pick JPY via 5000 > 3000
    const mixedCharges = [
      {
        id: "ch_jpy_1",
        status: "succeeded",
        amount: 5000,
        amount_captured: 5000,
        amount_refunded: 0,
        currency: "jpy",
        created: nowSec - 1000,
      },
      {
        id: "ch_usd_1",
        status: "succeeded",
        amount: 3000,
        amount_captured: 3000,
        amount_refunded: 0,
        currency: "usd",
        created: nowSec - 2000,
      },
    ];

    const fetchSpy = vi.fn(async () => jsonRes({ data: mixedCharges, has_more: false }));
    vi.stubGlobal("fetch", fetchSpy);

    const body = document.createElement("div");
    const { ctx, setSettings } = makeCtx();
    const inst = (await revenueWidget.mount(body, ctx)) as WidgetInstance;

    await vi.waitFor(() => {
      expect(body.querySelector("[data-total]")?.textContent).toBe("Select currency");
    });
    expect(body.querySelector("[data-bars]")?.children.length).toBe(0);
    expect(body.querySelector("[data-sub]")?.textContent).toContain("JPY");
    expect(body.querySelector("[data-sub]")?.textContent).toContain("USD");

    const jpyBtn = body.querySelector<HTMLButtonElement>('[data-currency="JPY"]')!;
    const usdBtn = body.querySelector<HTMLButtonElement>('[data-currency="USD"]')!;
    expect(jpyBtn).toBeTruthy();
    expect(usdBtn).toBeTruthy();

    // Selecting USD displays USD total & trend and notes other currency JPY without re-fetching
    usdBtn.click();
    expect(setSettings).toHaveBeenCalledWith({ currency: "USD" });
    expect(body.querySelector("[data-total]")?.textContent).toContain("30");
    expect(body.querySelector("[data-sub]")?.textContent).toContain("USD");
    expect(body.querySelector("[data-sub]")?.textContent).toContain("other: JPY");
    expect(body.querySelector("[data-bars]")?.children.length).toBe(14);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Switching to JPY displays JPY total & trend and notes other currency USD
    jpyBtn.click();
    expect(setSettings).toHaveBeenCalledWith({ currency: "JPY" });
    expect(body.querySelector("[data-total]")?.textContent).toContain("5,000");
    expect(body.querySelector("[data-sub]")?.textContent).toContain("JPY");
    expect(body.querySelector("[data-sub]")?.textContent).toContain("other: USD");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    inst.destroy?.();
  });

  it("distinguishes 401/403/429, respects Retry-After cooldown, isolates stale credentials, and aborts on destroy", async () => {
    vi.useFakeTimers();
    const nowSec = Math.floor(Date.now() / 1000);

    // 1. 403 permission error stays in data view with 403 message
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return jsonRes({}, { status: 403 });
      }),
    );

    const body = document.createElement("div");
    const { ctx } = makeCtx({}, { getSecret: vi.fn(async () => "sk_restricted") });
    const inst = (await revenueWidget.mount(body, ctx)) as WidgetInstance;
    await vi.advanceTimersByTimeAsync(0);

    expect(body.querySelector<HTMLElement>("[data-view]")?.style.display).toBe("");
    expect(body.querySelector("[data-msg]")?.textContent).toContain("403");

    // 2. 429 respects Retry-After and stops hammering during cooldown
    calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return jsonRes({}, { status: 429, headers: { "Retry-After": "30" } });
      }),
    );
    await inst.refresh!();
    expect(calls).toBe(1);
    expect(body.querySelector("[data-msg]")?.textContent).toContain("429");

    // During 30s cooldown, refresh does not hit fetch
    await vi.advanceTimersByTimeAsync(15_000);
    await inst.refresh!();
    expect(calls).toBe(1);

    // After 30s cooldown, 401 switches to connect view and halts polling with rejected key
    await vi.advanceTimersByTimeAsync(15_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return jsonRes({}, { status: 401 });
      }),
    );
    await inst.refresh!();
    expect(calls).toBe(2);
    expect(body.querySelector<HTMLElement>("[data-connect]")?.style.display).toBe("");
    expect(body.querySelector("[data-msg]")?.textContent).toContain("401");

    // Subsequent refresh with same 401-rejected key must NOT call fetch
    await inst.refresh!();
    expect(calls).toBe(2);

    // 3. Stale credential isolation: saving sk_new while sk_old is pending (and ignores AbortSignal)
    vi.useRealTimers();
    const staleDeferred = deferred<Response>();
    let staleSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: unknown, init?: RequestInit) => {
        const auth = (init?.headers as Record<string, string>)?.Authorization ?? "";
        if (auth.includes("sk_old")) {
          staleSignal = init?.signal;
          return staleDeferred.promise;
        }
        if (auth.includes("sk_new")) {
          return Promise.resolve(
            jsonRes({
              data: [
                {
                  id: "ch_new",
                  status: "succeeded",
                  amount_captured: 7500,
                  amount_refunded: 0,
                  currency: "usd",
                  created: nowSec - 60,
                },
              ],
              has_more: false,
            }),
          );
        }
        return Promise.resolve(jsonRes({}, { status: 404 }));
      }),
    );

    const body2 = document.createElement("div");
    let storedKey = "sk_old";
    const ctx2 = makeCtx(
      {},
      {
        getSecret: vi.fn(async () => storedKey),
        setSecret: vi.fn(async (_k, v) => {
          storedKey = v;
        }),
      },
    ).ctx;
    const inst2 = (await revenueWidget.mount(body2, ctx2)) as WidgetInstance;

    // While sk_old is pending, user enters and saves sk_new
    const input = body2.querySelector<HTMLInputElement>("[data-key]")!;
    const saveBtn = body2.querySelector<HTMLButtonElement>("[data-save]")!;
    input.value = "sk_new";
    saveBtn.click();

    await vi.waitFor(() => {
      expect(body2.querySelector("[data-total]")?.textContent).toContain("75");
    });
    expect(staleSignal?.aborted).toBe(true);

    // Late arrival of sk_old 401 must NOT switch sk_new back to connect view or reject sk_new
    staleDeferred.resolve(jsonRes({}, { status: 401 }));
    await Promise.resolve();
    await Promise.resolve();
    expect(body2.querySelector("[data-total]")?.textContent).toContain("75");
    expect(body2.querySelector<HTMLElement>("[data-view]")?.style.display).toBe("");
    expect(body2.querySelector("[data-msg]")?.textContent).toBe("");

    // 4. Same-key concurrent refresh coalesces & unmount aborts in-flight fetch
    const hanging = deferred<Response>();
    let hangCalls = 0;
    let hangSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: unknown, init?: RequestInit) => {
        hangCalls += 1;
        hangSignal = init?.signal;
        return hanging.promise;
      }),
    );
    const p1 = inst2.refresh!();
    const p2 = inst2.refresh!();
    expect(hangCalls).toBe(1);
    expect(hangSignal?.aborted).toBe(false);

    inst2.destroy?.();
    expect(hangSignal?.aborted).toBe(true);
    hanging.resolve(
      jsonRes({
        data: [
          {
            id: "ch_after_destroy",
            status: "succeeded",
            amount_captured: 99_900,
            amount_refunded: 0,
            currency: "usd",
            created: nowSec - 10,
          },
        ],
        has_more: false,
      }),
    );
    await Promise.all([p1, p2]);
    expect(body2.querySelector("[data-total]")?.textContent).toContain("75");

    inst.destroy?.();
  });
});
