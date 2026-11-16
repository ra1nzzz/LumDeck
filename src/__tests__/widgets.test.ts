import { describe, it, expect, afterEach, vi } from "vitest";
import type { WidgetContext } from "../core/types";

// Call-layer tests: exercise the exact URL / auth / parsing / degradation of the
// widgets that talk to external services, with fetch stubbed and secrets served
// from the (stubbed) credential vault rather than localStorage.

function makeCtx(overrides: Partial<WidgetContext> = {}): WidgetContext {
  return {
    uid: "u1",
    settings: {},
    invoke: vi.fn(async () => {
      throw new Error("no command");
    }),
    setSettings: vi.fn(),
    onSettings: () => () => {},
    setSecret: vi.fn(async () => {}),
    getSecret: vi.fn(async () => null),
    deleteSecret: vi.fn(async () => {}),
    ...overrides,
  } as WidgetContext;
}

function res(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  const status = init.status ?? 200;
  const lower: Record<string, string> = {};
  for (const k in init.headers ?? {}) lower[k.toLowerCase()] = init.headers![k];
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => lower[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe("github-activity call layer", () => {
  it("reads the PAT from the vault, sends Bearer, and reads unread from Link rel=last", async () => {
    const mod = (await import("../widgets/analytics/github-activity.widget")).default;
    const ctx = makeCtx({ getSecret: vi.fn(async () => "ghp_secret") });
    const calls: { url: string; opts: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, opts: RequestInit) => {
        calls.push({ url: String(url), opts });
        const u = String(url);
        if (u.includes("/notifications"))
          return res([{ id: 1 }], {
            headers: {
              link: '<https://api.github.com/notifications?per_page=1&page=7>; rel="last", <...>; rel="next"',
            },
          });
        if (u.includes("/user")) return res({ login: "octocat" });
        return res({}, { status: 404 });
      }),
    );
    const body = document.createElement("div");
    await mod.mount(body, ctx);
    // mount auto-loads via its own initial refresh; just wait for the value.

    expect(ctx.getSecret).toHaveBeenCalledWith("token");
    const notif = calls.find((c) => c.url.includes("/notifications"));
    expect(notif).toBeTruthy();
    expect(notif!.url).toContain("per_page=1");
    expect((notif!.opts.headers as Record<string, string>).Authorization).toBe("Bearer ghp_secret");
    await vi.waitFor(() => expect(body.textContent).toContain("7")); // unread = rel=last page, not *50
  });

  it("renders a connect state and makes no request without a token", async () => {
    const mod = (await import("../widgets/analytics/github-activity.widget")).default;
    const ctx = makeCtx({ getSecret: vi.fn(async () => null) });
    const fetchSpy = vi.fn(async () => res({}, { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);
    const body = document.createElement("div");
    await mod.mount(body, ctx);
    await vi.waitFor(() => expect(fetchSpy).not.toHaveBeenCalled());
  });
});

describe("gmail-unread call layer", () => {
  it("sends Bearer token and renders messagesUnread", async () => {
    const mod = (await import("../widgets/online/gmail-unread.widget")).default;
    const ctx = makeCtx({ getSecret: vi.fn(async () => "ya29.token") });
    const calls: { url: string; opts: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, opts: RequestInit) => {
        calls.push({ url: String(url), opts });
        return res({ messagesUnread: 42, messagesTotal: 100 });
      }),
    );
    const body = document.createElement("div");
    await mod.mount(body, ctx);
    // mount auto-loads via its own initial refresh; just wait for the value.
    expect(ctx.getSecret).toHaveBeenCalledWith("accessToken");
    expect(calls[0].url).toContain("gmail.googleapis.com");
    expect(calls[0].url).toContain("labels/INBOX");
    expect((calls[0].opts.headers as Record<string, string>).Authorization).toBe("Bearer ya29.token");
    await vi.waitFor(() => expect(body.textContent).toContain("42"));
  });
});

describe("revenue call layer", () => {
  it("sums net succeeded charges in the last 30 days with Bearer auth", async () => {
    const mod = (await import("../widgets/finance/revenue.widget")).default;
    const ctx = makeCtx({ getSecret: vi.fn(async () => "sk_test") });
    const now = Math.floor(Date.now() / 1000);
    const charges = [
      { id: "ch_1", amount: 1000, amount_captured: 1000, amount_refunded: 0, currency: "usd", status: "succeeded", created: now - 3600 },
      { id: "ch_2", amount: 2500, amount_captured: 2500, amount_refunded: 500, currency: "usd", status: "succeeded", created: now - 7200 },
      { id: "ch_3", amount: 9999, amount_captured: 0, amount_refunded: 0, currency: "usd", status: "failed", created: now - 60 }, // excluded
      { id: "ch_4", amount: 5000, amount_captured: 5000, amount_refunded: 0, currency: "usd", status: "succeeded", created: now - 999_999_999 }, // >30d, excluded
    ];
    let auth = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, opts: RequestInit) => {
        auth = (opts.headers as Record<string, string>).Authorization;
        return res({ data: charges, has_more: false });
      }),
    );
    const body = document.createElement("div");
    await mod.mount(body, ctx);
    // mount auto-loads via its own initial refresh; just wait for the value.
    expect(auth).toBe("Bearer sk_test");
    // net = (1000) + (2500-500) = 3000 cents = $30.00
    await vi.waitFor(() => expect(body.textContent).toContain("30"));
  });
});

describe("instagram-followers call layer", () => {
  it("passes access_token and renders followers_count", async () => {
    const mod = (await import("../widgets/social/instagram-followers.widget")).default;
    const ctx = makeCtx({
      settings: { userId: "17841400000" },
      getSecret: vi.fn(async () => "IGTOK"),
    });
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        urls.push(String(url));
        return res({ followers_count: 850, username: "acme" });
      }),
    );
    const body = document.createElement("div");
    await mod.mount(body, ctx);
    // mount auto-loads via its own initial refresh; just wait for the value.
    expect(ctx.getSecret).toHaveBeenCalledWith("accessToken");
    expect(urls[0]).toContain("access_token=IGTOK");
    await vi.waitFor(() => expect(body.textContent).toContain("850"));
  });
});

describe("stock-quote call layer", () => {
  it("uses the Finnhub key from the vault and renders the price", async () => {
    const mod = (await import("../widgets/stocks/stock-quote.widget")).default;
    const ctx = makeCtx({
      settings: { symbol: "AAPL" },
      getSecret: vi.fn(async () => "fh_key"),
    });
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        urls.push(String(url));
        return res({ c: 195.3, dp: 1.23, h: 198, l: 193, o: 194, pc: 192.9 });
      }),
    );
    const body = document.createElement("div");
    await mod.mount(body, ctx);
    // mount auto-loads via its own initial refresh; just wait for the value.
    expect(ctx.getSecret).toHaveBeenCalledWith("apiKey");
    expect(urls[0]).toContain("finnhub.io");
    expect(urls[0]).toContain("symbol=AAPL");
    expect(urls[0]).toContain("token=fh_key");
    await vi.waitFor(() => expect(body.textContent).toContain("195"));
  });
});
