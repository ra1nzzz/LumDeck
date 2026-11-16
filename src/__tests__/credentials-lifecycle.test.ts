import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WidgetContext, WidgetModule } from "../core/types";

class MemStorage {
  private m = new Map<string, string>();
  failNextSet = false;
  failAllSets = false;

  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    if (this.failAllSets) {
      throw new Error("QuotaExceededError");
    }
    if (this.failNextSet) {
      this.failNextSet = false;
      throw new Error("QuotaExceededError");
    }
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  get length(): number {
    return this.m.size;
  }
}

interface MockVaultOptions {
  initial?: Record<string, string>;
  readErrorOnKey?: Record<string, string>;
  writeErrorOnKey?: Record<string, string>;
  deleteErrorOnKey?: Record<string, string>;
}

function createMockVault(opts: MockVaultOptions = {}) {
  const entries = new Map<string, string>(Object.entries(opts.initial ?? {}));
  const calls: { cmd: string; key: string }[] = [];
  const readErrors = new Map<string, string>(Object.entries(opts.readErrorOnKey ?? {}));
  const writeErrors = new Map<string, string>(Object.entries(opts.writeErrorOnKey ?? {}));
  const deleteErrors = new Map<string, string>(Object.entries(opts.deleteErrorOnKey ?? {}));

  const invokeSpy = vi.fn(async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    const key = String(args?.key ?? "");
    calls.push({ cmd, key });
    if (cmd === "cred_get") {
      const err = readErrors.get(key);
      if (err) throw new Error(err);
      return entries.has(key) ? entries.get(key)! : null;
    }
    if (cmd === "cred_set") {
      const err = writeErrors.get(key);
      if (err) throw new Error(err);
      entries.set(key, String(args?.secret ?? ""));
      return undefined;
    }
    if (cmd === "cred_delete") {
      const err = deleteErrors.get(key);
      if (err) throw new Error(err);
      entries.delete(key);
      return undefined;
    }
    throw new Error(`unexpected command ${cmd}`);
  });
  const invoke = <T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
    invokeSpy(cmd, args) as Promise<T>;

  return { entries, calls, readErrors, writeErrors, deleteErrors, invoke, invokeSpy };
}

let storage: MemStorage;

beforeEach(() => {
  storage = new MemStorage();
  (globalThis as unknown as { localStorage: MemStorage }).localStorage = storage;
  const w = (globalThis as unknown as { window?: Record<string, unknown> }).window;
  if (w) {
    w.localStorage = storage;
    delete w.__TAURI__;
    delete w.__TAURI_INTERNALS__;
  }
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock("../core/tauri");
});

describe("C1: legacy credential migration & store ownership", () => {
  it("migrates all 6 widget legacy fields to LumDeck:<uid>:<key>, keeps Vault values when present, and cleans localStorage", async () => {
    storage.setItem(
      "lumdeck.state.v1",
      JSON.stringify({
        layout: [
          { uid: "gh-1", widgetId: "github-activity", size: { w: 2, h: 1 }, settings: { token: "old-gh" } },
          { uid: "gm-1", widgetId: "gmail-unread", size: { w: 2, h: 1 }, settings: { accessToken: "old-gm" } },
          { uid: "ig-1", widgetId: "instagram-followers", size: { w: 2, h: 1 }, settings: { accessToken: "old-ig", userId: "42" } },
          { uid: "st-1", widgetId: "revenue", size: { w: 3, h: 1 }, settings: { apiKey: "old-stripe" } },
          { uid: "sq-1", widgetId: "stock-quote", size: { w: 2, h: 1 }, settings: { apiKey: "old-finnhub", symbol: "MSFT" } },
          { uid: "ai-1", widgetId: "ai-usage", size: { w: 3, h: 1 }, settings: { sessionKey: "old-ai", provider: "claude" } },
        ],
      }),
    );

    const vault = createMockVault({
      initial: {
        // Vault already has a value for gm-1 -> must win over old-gm
        "gm-1:accessToken": "vault-gm-wins",
      },
    });

    const { store, storeCredentialPort } = await import("../core/store");
    const { createCredentialManager } = await import("../core/credentials");

    // Non-secret store view never exposes legacy secrets
    expect(store.widgetSettings("gh-1")).toEqual({});
    expect(store.widgetSettings("ig-1")).toEqual({ userId: "42" });
    expect(store.widgetSettings("sq-1")).toEqual({ symbol: "MSFT" });

    // General settings write BEFORE migration preserves unmigrated legacy keys on disk
    store.setWidgetSettings("sq-1", { symbol: "NVDA", apiKey: "attempted-new-plaintext" });
    expect(store.widgetSettings("sq-1")).toEqual({ symbol: "NVDA" });
    const rawBeforeMigrate = JSON.parse(storage.getItem("lumdeck.state.v1")!);
    expect(rawBeforeMigrate.layout[4].settings.apiKey).toBe("old-finnhub");

    const mgr = createCredentialManager({
      store: storeCredentialPort,
      invoke: vault.invoke,
      isTauri: () => true,
    });

    const expected: Array<[string, string, string, string]> = [
      ["gh-1", "github-activity", "token", "old-gh"],
      ["gm-1", "gmail-unread", "accessToken", "vault-gm-wins"],
      ["ig-1", "instagram-followers", "accessToken", "old-ig"],
      ["st-1", "revenue", "apiKey", "old-stripe"],
      ["sq-1", "stock-quote", "apiKey", "old-finnhub"],
      ["ai-1", "ai-usage", "sessionKey", "old-ai"],
    ];

    for (const [uid, widgetId, secretKey, value] of expected) {
      expect(await mgr.getSecret(uid, widgetId, secretKey)).toBe(value);
      expect(vault.entries.get(`${uid}:${secretKey}`)).toBe(value);
    }

    // gm-1 had an existing Vault entry, so cred_set must NOT overwrite it
    expect(vault.calls.some((c) => c.cmd === "cred_set" && c.key === "gm-1:accessToken")).toBe(false);

    // Non-secret settings remain and all legacy plaintext secrets are stripped from localStorage
    const rawAfter = JSON.parse(storage.getItem("lumdeck.state.v1")!);
    expect(rawAfter.layout[0].settings).toEqual({});
    expect(rawAfter.layout[1].settings).toEqual({});
    expect(rawAfter.layout[2].settings).toEqual({ userId: "42" });
    expect(rawAfter.layout[3].settings).toEqual({});
    expect(rawAfter.layout[4].settings).toEqual({ symbol: "NVDA" });
    expect(rawAfter.layout[5].settings).toEqual({ provider: "claude" });
  });

  it("recovers cleanly after Vault read failure, write/verify failure, and localStorage persistence failure", async () => {
    storage.setItem(
      "lumdeck.state.v1",
      JSON.stringify({
        layout: [
          { uid: "gh-r", widgetId: "github-activity", size: { w: 2, h: 1 }, settings: { token: "legacy-gh" } },
          { uid: "sq-w", widgetId: "stock-quote", size: { w: 2, h: 1 }, settings: { apiKey: "legacy-sq", symbol: "AAPL" } },
          { uid: "st-p", widgetId: "revenue", size: { w: 3, h: 1 }, settings: { apiKey: "legacy-st" } },
        ],
      }),
    );

    const vault = createMockVault({
      readErrorOnKey: { "gh-r:token": "ERROR_ACCESS_DENIED" },
      writeErrorOnKey: { "sq-w:apiKey": "ERROR_GEN_FAILURE" },
    });

    const { storeCredentialPort } = await import("../core/store");
    const { createCredentialManager, SecretVaultError } = await import("../core/credentials");

    const mgr = createCredentialManager({
      store: storeCredentialPort,
      invoke: vault.invoke,
      isTauri: () => true,
    });

    // 1. Read failure: must NOT overwrite Vault, must keep legacy token in localStorage
    await expect(mgr.getSecret("gh-r", "github-activity", "token")).rejects.toBeInstanceOf(SecretVaultError);
    expect(vault.calls.some((c) => c.cmd === "cred_set" && c.key === "gh-r:token")).toBe(false);
    expect(JSON.parse(storage.getItem("lumdeck.state.v1")!).layout[0].settings.token).toBe("legacy-gh");

    // Retry after read fault clears
    vault.readErrors.delete("gh-r:token");
    expect(await mgr.getSecret("gh-r", "github-activity", "token")).toBe("legacy-gh");
    expect(JSON.parse(storage.getItem("lumdeck.state.v1")!).layout[0].settings.token).toBeUndefined();

    // 2. Write failure: must preserve legacy apiKey in localStorage; retry succeeds
    await expect(mgr.getSecret("sq-w", "stock-quote", "apiKey")).rejects.toBeInstanceOf(SecretVaultError);
    expect(JSON.parse(storage.getItem("lumdeck.state.v1")!).layout[1].settings.apiKey).toBe("legacy-sq");

    vault.writeErrors.delete("sq-w:apiKey");
    expect(await mgr.getSecret("sq-w", "stock-quote", "apiKey")).toBe("legacy-sq");
    expect(JSON.parse(storage.getItem("lumdeck.state.v1")!).layout[1].settings).toEqual({ symbol: "AAPL" });

    // 3. localStorage persistence failure after Vault write: must NOT mark cleaned, next retry succeeds
    storage.failNextSet = true;
    await expect(mgr.getSecret("st-p", "revenue", "apiKey")).rejects.toMatchObject({
      code: "persistence_failed",
    });
    expect(vault.entries.get("st-p:apiKey")).toBe("legacy-st");
    expect(JSON.parse(storage.getItem("lumdeck.state.v1")!).layout[2].settings.apiKey).toBe("legacy-st");

    expect(await mgr.getSecret("st-p", "revenue", "apiKey")).toBe("legacy-st");
    expect(vault.calls.filter((c) => c.cmd === "cred_set" && c.key === "st-p:apiKey")).toHaveLength(1);
    expect(JSON.parse(storage.getItem("lumdeck.state.v1")!).layout[2].settings.apiKey).toBeUndefined();
  });

  it("supports session-only credentials in browser preview without writing plaintext or falsely marking migrated", async () => {
    storage.setItem(
      "lumdeck.state.v1",
      JSON.stringify({
        layout: [
          { uid: "gh-p", widgetId: "github-activity", size: { w: 2, h: 1 }, settings: { token: "legacy-preview" } },
          { uid: "sq-p", widgetId: "stock-quote", size: { w: 2, h: 1 }, settings: { symbol: "AAPL" } },
        ],
      }),
    );

    const { storeCredentialPort } = await import("../core/store");
    const { createCredentialManager } = await import("../core/credentials");

    const invokeSpy = vi.fn();
    const mgr = createCredentialManager({
      store: storeCredentialPort,
      invoke: invokeSpy,
      isTauri: () => false,
    });

    // Session-only read/write/delete works without touching Vault or cleaning legacy localStorage
    expect(await mgr.getSecret("gh-p", "github-activity", "token")).toBe("legacy-preview");
    expect(invokeSpy).not.toHaveBeenCalled();
    await mgr.setSecret("sq-p", "stock-quote", "apiKey", "session-only-secret");
    expect(await mgr.getSecret("sq-p", "stock-quote", "apiKey")).toBe("session-only-secret");

    // Nothing new written as plaintext into localStorage, legacy untouched
    const raw = storage.getItem("lumdeck.state.v1")!;
    expect(raw).not.toContain("session-only-secret");
    expect(JSON.parse(raw).layout[0].settings.token).toBe("legacy-preview");

    await mgr.deleteSecret("sq-p", "stock-quote", "apiKey");
    expect(await mgr.getSecret("sq-p", "stock-quote", "apiKey")).toBeNull();
  });
});

describe("C2: tile deletion, concurrency serialization, two-UID isolation, and provider save/clear", () => {
  it("serializes per-UID operations, preserves two-UID isolation, and handles idempotent delete", async () => {
    const order: string[] = [];
    let gateResolve!: () => void;
    const gate = new Promise<void>((r) => {
      gateResolve = r;
    });
    const entries = new Map<string, string>();
    const invokeSpy = vi.fn(async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
      const key = String(args?.key ?? "");
      order.push(`start:${cmd}:${key}`);
      if (cmd === "cred_set" && key === "uA:token" && args?.secret === "first") {
        await gate;
      }
      if (cmd === "cred_set") entries.set(key, String(args?.secret ?? ""));
      if (cmd === "cred_get") return entries.get(key) ?? null;
      if (cmd === "cred_delete") entries.delete(key);
      order.push(`end:${cmd}:${key}`);
      return undefined;
    });
    const invoke = <T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
      invokeSpy(cmd, args) as Promise<T>;

    const { storeCredentialPort } = await import("../core/store");
    const { createCredentialManager } = await import("../core/credentials");

    const mgr = createCredentialManager({
      store: storeCredentialPort,
      invoke,
      isTauri: () => true,
    });

    const p1 = mgr.setSecret("uA", "github-activity", "token", "first");
    const p2 = mgr.getSecret("uA", "github-activity", "token");
    const p3 = mgr.setSecret("uB", "github-activity", "token", "other-user");

    // uB is NOT blocked by uA's pending write
    await p3;
    expect(entries.get("uB:token")).toBe("other-user");
    expect(order).not.toContain("start:cred_get:uA:token");

    gateResolve();
    await p1;
    expect(await p2).toBe("first");
    expect(order.indexOf("end:cred_set:uA:token")).toBeLessThan(order.indexOf("start:cred_get:uA:token"));

    // Idempotent duplicate deletes on uA do not touch uB
    await mgr.deleteWidgetSecrets("uA", "github-activity");
    await mgr.deleteWidgetSecrets("uA", "github-activity");
    expect(entries.has("uA:token")).toBe(false);
    expect(entries.get("uB:token")).toBe("other-user");
  });

  it("handles explicit tile remove with double-click guard, Vault delete failure retry, and partial persist failure", async () => {
    const vault = createMockVault({
      initial: {
        "u1:token": "pat-one",
        "u2:token": "pat-two",
      },
      deleteErrorOnKey: {
        "u1:token": "ERROR_ACCESS_DENIED",
      },
    });

    storage.setItem(
      "lumdeck.state.v1",
      JSON.stringify({
        layout: [
          { uid: "u1", widgetId: "github-activity", size: { w: 2, h: 1 }, settings: {} },
          { uid: "u2", widgetId: "github-activity", size: { w: 2, h: 1 }, settings: {} },
        ],
      }),
    );

    vi.doMock("../core/tauri", () => ({
      hasTauri: true,
      invoke: vault.invoke,
      listen: () => () => {},
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ login: "octocat" }),
      })),
    );

    const { store } = await import("../core/store");
    const { registry } = await import("../core/registry");
    const ghMod = (await import("../widgets/analytics/github-activity.widget")).default;
    registry.register(ghMod);
    const { renderTile } = await import("../dock/tile");

    const placed1 = store.get().layout[0];
    const tile1 = renderTile(placed1);
    const removeBtn = tile1.querySelector<HTMLButtonElement>(".tile-remove")!;

    // 1. Vault delete failure keeps layout & shows retryable error
    removeBtn.click();
    removeBtn.click(); // double-click while in flight
    await vi.waitFor(() => {
      expect(tile1.querySelector("[data-tile-error]")?.textContent).toContain("Vault delete failed");
    });
    expect(vault.calls.filter((c) => c.cmd === "cred_delete" && c.key === "u1:token")).toHaveLength(1);
    expect(store.get().layout.map((p) => p.uid)).toEqual(["u1", "u2"]);
    expect(removeBtn.disabled).toBe(false);

    // 2. Vault delete now succeeds, but localStorage persistence fails -> honest partial error, layout preserved
    vault.deleteErrors.delete("u1:token");
    storage.failNextSet = true;
    removeBtn.click();
    await vi.waitFor(() => {
      expect(tile1.querySelector("[data-tile-error]")?.textContent).toContain("Secret cleared; layout save failed");
    });
    expect(vault.entries.has("u1:token")).toBe(false);
    expect(vault.entries.get("u2:token")).toBe("pat-two");
    expect(store.get().layout.map((p) => p.uid)).toEqual(["u1", "u2"]);
    expect(removeBtn.disabled).toBe(false);

    // 3. Retry after localStorage recovers -> idempotent delete + tile removed, u2 untouched
    removeBtn.click();
    await vi.waitFor(() => {
      expect(store.get().layout.map((p) => p.uid)).toEqual(["u2"]);
    });
    expect(vault.entries.get("u2:token")).toBe("pat-two");

    // 4. Temporary unmount & reorder do NOT delete Vault secrets
    const placed2 = store.get().layout[0];
    const tile2 = renderTile(placed2);
    await Promise.resolve();
    (tile2 as unknown as { __destroy: () => void }).__destroy();
    expect(vault.entries.get("u2:token")).toBe("pat-two");
  });

  it("all 6 credential widgets wait for setSecret/deleteSecret success, preserve state/form on error, distinguish Vault faults, and secure Gmail input", async () => {
    const github = (await import("../widgets/analytics/github-activity.widget")).default;
    const gmail = (await import("../widgets/online/gmail-unread.widget")).default;
    const instagram = (await import("../widgets/social/instagram-followers.widget")).default;
    const revenue = (await import("../widgets/finance/revenue.widget")).default;
    const stock = (await import("../widgets/stocks/stock-quote.widget")).default;
    const aiUsage = (await import("../widgets/ai/ai-usage.widget")).default;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          login: "octocat",
          messagesUnread: 3,
          followers_count: 100,
          username: "acme",
          data: [],
          has_more: false,
          c: 150,
          dp: 1.5,
          h: 155,
          l: 149,
        }),
      })),
    );

    const makeFailThenOkCtx = (
      secretName: string,
      opts: { failGetOnce?: boolean; initialSecret?: string | null; settings?: Record<string, unknown> } = {},
    ) => {
      let secretVal: string | null = opts.initialSecret ?? null;
      let failGet = opts.failGetOnce ?? false;
      let failSet = true;
      let failDel = true;
      const settings = { ...(opts.settings ?? {}) };
      const ctx: WidgetContext = {
        uid: "test-w",
        settings,
        invoke: (async () => {
          if (!secretVal) throw new Error("not signed in");
          return { session: { percent: 10 }, weekly: { percent: 20 } };
        }) as WidgetContext["invoke"],
        setSettings: vi.fn((patch) => Object.assign(settings, patch)),
        onSettings: () => () => {},
        getSecret: vi.fn(async () => {
          if (failGet) {
            failGet = false;
            throw new Error("vault read fault");
          }
          return secretVal;
        }),
        setSecret: vi.fn(async (_k, v) => {
          if (failSet) {
            failSet = false;
            throw new Error(`vault write failed for ${v}`);
          }
          secretVal = v;
        }),
        deleteSecret: vi.fn(async () => {
          if (failDel) {
            failDel = false;
            throw new Error("vault delete fault");
          }
          secretVal = null;
        }),
      };
      return { ctx, settings, getVal: () => secretVal, secretName };
    };

    const saveCases: Array<{
      mod: WidgetModule;
      inputSel: string;
      saveSel: string;
      secretName: string;
      secretValue: string;
      verifyConnected: (body: HTMLElement) => boolean;
      extraCheck?: (body: HTMLElement) => void;
    }> = [
      {
        mod: github,
        inputSel: "[data-token]",
        saveSel: "[data-save]",
        secretName: "token",
        secretValue: "ghp_secret_123",
        verifyConnected: (b) => Boolean(b.querySelector("[data-count]")),
      },
      {
        mod: gmail,
        inputSel: "[data-token]",
        saveSel: "[data-save]",
        secretName: "accessToken",
        secretValue: "ya29.secret_123",
        verifyConnected: (b) => Boolean(b.querySelector("[data-count]")),
        extraCheck: (b) => {
          const inp = b.querySelector<HTMLInputElement>("[data-token]")!;
          expect(inp.type).toBe("password");
          expect(inp.getAttribute("spellcheck")).toBe("false");
        },
      },
      {
        mod: instagram,
        inputSel: "[data-token]",
        saveSel: "[data-save]",
        secretName: "accessToken",
        secretValue: "IG_SECRET_123",
        verifyConnected: (b) => Boolean(b.querySelector("[data-count]")),
      },
      {
        mod: revenue,
        inputSel: "[data-key]",
        saveSel: "[data-save]",
        secretName: "apiKey",
        secretValue: "sk_live_secret_123",
        verifyConnected: (b) => (b.querySelector<HTMLElement>("[data-view]")?.style.display ?? "") !== "none",
      },
      {
        mod: stock,
        inputSel: "[data-key-input]",
        saveSel: "[data-save]",
        secretName: "apiKey",
        secretValue: "fh_secret_123",
        verifyConnected: (b) => Boolean(b.querySelector("[data-price]")),
      },
      {
        mod: aiUsage,
        inputSel: "[data-token]",
        saveSel: "[data-connect]",
        secretName: "sessionKey",
        secretValue: "ai_session_secret_123",
        verifyConnected: (b) => Boolean(b.querySelector("[data-most]")),
      },
    ];

    for (const c of saveCases) {
      const body = document.createElement("div");
      const { ctx, getVal } = makeFailThenOkCtx(c.secretName, { failGetOnce: true });
      const inst = await c.mod.mount(body, ctx);

      // Vault read failure must show Retry (not Connect form)
      const retryBtn = body.querySelector<HTMLButtonElement>("[data-retry]");
      expect(retryBtn, `${c.mod.id} should show vault retry`).toBeTruthy();
      retryBtn!.click();
      await vi.waitFor(() => expect(body.querySelector(c.inputSel)).toBeTruthy());

      c.extraCheck?.(body);

      const input = body.querySelector<HTMLInputElement>(c.inputSel)!;
      const saveBtn = body.querySelector<HTMLButtonElement>(c.saveSel)!;
      input.value = c.secretValue;

      // Save failure preserves form, preserves user input, does not leak secret, does not connect
      saveBtn.click();
      await vi.waitFor(() => {
        expect(saveBtn.disabled).toBe(false);
        expect(body.textContent).not.toContain(c.secretValue);
      });
      expect(getVal()).toBeNull();
      expect(body.querySelector<HTMLInputElement>(c.inputSel)?.value).toBe(c.secretValue);
      expect(c.verifyConnected(body)).toBe(false);

      // Retry succeeds and transitions to connected view
      saveBtn.click();
      await vi.waitFor(() => expect(c.verifyConnected(body)).toBe(true));
      expect(getVal()).toBe(c.secretValue);
      inst.destroy?.();
    }

    // Clear failure & retry on instagram-followers and stock-quote
    for (const mod of [instagram, stock]) {
      const body = document.createElement("div");
      const { ctx, getVal } = makeFailThenOkCtx("k", { initialSecret: "keep_me" });
      const inst = await mod.mount(body, ctx);
      await vi.waitFor(() => expect(body.querySelector("[data-key]")).toBeTruthy());

      const keyBtn = body.querySelector<HTMLButtonElement>("[data-key]")!;
      keyBtn.click();
      await vi.waitFor(() => expect(keyBtn.disabled).toBe(false));
      expect(getVal()).toBe("keep_me");
      expect(body.querySelector("[data-key]")).toBeTruthy();

      keyBtn.click();
      await vi.waitFor(() => expect(body.querySelector("[data-save]")).toBeTruthy());
      expect(getVal()).toBeNull();
      inst.destroy?.();
    }
  });
});

describe("C3: tile lifecycle cancellation, non-reentrant auto-refresh, duplicate UID dedupe, and reorder", () => {
  it("skips mount if destroyed before microtask, aborts pending mount signal, and destroys late instance once", async () => {
    const { registry } = await import("../core/registry");
    const { renderTile } = await import("../dock/tile");

    // 1. Destroyed synchronously before mount runs -> mount never called
    const neverMountSpy = vi.fn(() => ({}));
    registry.register({
      id: "test-never-mount",
      name: "Never",
      group: "apps",
      icon: "",
      defaultSize: { w: 1, h: 1 },
      mount: neverMountSpy,
    });
    const earlyTile = renderTile({ uid: "early-1", widgetId: "test-never-mount", size: { w: 1, h: 1 }, settings: {} });
    (earlyTile as unknown as { __destroy: () => void }).__destroy();
    await Promise.resolve();
    await Promise.resolve();
    expect(neverMountSpy).not.toHaveBeenCalled();

    // 2. Destroyed while async mount pending -> signal aborts immediately & late instance destroyed once
    let resolveMount!: (inst: { destroy: () => void }) => void;
    let capturedSignal: AbortSignal | undefined;
    const lateDestroySpy = vi.fn();
    registry.register({
      id: "test-late-mount",
      name: "Late",
      group: "apps",
      icon: "",
      defaultSize: { w: 1, h: 1 },
      mount: (_body, ctx) => {
        capturedSignal = ctx.signal;
        return new Promise((r) => {
          resolveMount = r;
        });
      },
    });
    const lateTile = renderTile({ uid: "late-1", widgetId: "test-late-mount", size: { w: 1, h: 1 }, settings: {} });
    await Promise.resolve();
    expect(capturedSignal?.aborted).toBe(false);

    const destroyFn = (lateTile as unknown as { __destroy: () => void }).__destroy;
    destroyFn();
    destroyFn(); // idempotent repeat
    expect(capturedSignal?.aborted).toBe(true);
    expect(lateDestroySpy).not.toHaveBeenCalled();

    resolveMount({ destroy: lateDestroySpy });
    await vi.waitFor(() => expect(lateDestroySpy).toHaveBeenCalledTimes(1));
  });

  it("schedules next auto-refresh only after previous refresh completes (no reentrancy)", async () => {
    vi.useFakeTimers();
    const { registry } = await import("../core/registry");
    const { renderTile } = await import("../dock/tile");

    let active = 0;
    let maxConcurrent = 0;
    let calls = 0;
    let finishFirst!: () => void;

    registry.register({
      id: "test-non-reentrant",
      name: "NoReentry",
      group: "apps",
      icon: "",
      defaultSize: { w: 1, h: 1 },
      refreshMs: 1000,
      mount: () => ({
        refresh: async () => {
          calls += 1;
          active += 1;
          maxConcurrent = Math.max(maxConcurrent, active);
          if (calls === 1) {
            await new Promise<void>((r) => {
              finishFirst = r;
            });
          }
          active -= 1;
        },
      }),
    });

    const tile = renderTile({ uid: "nr-1", widgetId: "test-non-reentrant", size: { w: 1, h: 1 }, settings: {} });
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(3500);
    expect(calls).toBe(1);
    expect(maxConcurrent).toBe(1);

    finishFirst();
    await vi.advanceTimersByTimeAsync(0);
    // Next tick is 1000ms AFTER first refresh settled
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);

    (tile as unknown as { __destroy: () => void }).__destroy();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(2);
  });

  it("deduplicates duplicate UIDs stably preserving first valid UID and keeps settings/layout across reorder", async () => {
    storage.setItem(
      "lumdeck.state.v1",
      JSON.stringify({
        layout: [
          { uid: "", widgetId: "clock-digital", size: { w: 2, h: 1 }, settings: { drop: true } },
          { uid: "dup-uid", widgetId: "github-activity", size: { w: 2, h: 1 }, settings: { token: "first-pat", label: "keep" } },
          { uid: "dup-uid", widgetId: "stock-quote", size: { w: 2, h: 1 }, settings: { symbol: "DROP" } },
          { uid: "second-uid", widgetId: "stock-quote", size: { w: 2, h: 1 }, settings: { symbol: "AAPL" } },
        ],
      }),
    );

    const { store, storeCredentialPort } = await import("../core/store");
    const layout = store.get().layout;
    expect(layout.map((p) => p.uid)).toEqual(["dup-uid", "second-uid"]);
    expect(layout[0].widgetId).toBe("github-activity");
    expect(layout[0].settings).toEqual({ label: "keep" });
    expect(storeCredentialPort.getLegacySecret("dup-uid", "token")).toBe("first-pat");

    // Reorder preserves UIDs, non-sensitive settings, and unmigrated legacy credential
    store.moveWidget(0, 1);
    expect(store.get().layout.map((p) => p.uid)).toEqual(["second-uid", "dup-uid"]);
    expect(store.widgetSettings("dup-uid")).toEqual({ label: "keep" });
    expect(store.widgetSettings("second-uid")).toEqual({ symbol: "AAPL" });
    expect(storeCredentialPort.getLegacySecret("dup-uid", "token")).toBe("first-pat");
  });

  it("gmail-unread and ai-usage mount returns destroy handle before slow network finishes", async () => {
    const gmail = (await import("../widgets/online/gmail-unread.widget")).default;
    const aiUsage = (await import("../widgets/ai/ai-usage.widget")).default;

    let abortObserved = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: unknown, init?: RequestInit) => {
        init?.signal?.addEventListener("abort", () => {
          abortObserved = true;
        });
        return new Promise<Response>(() => {});
      }),
    );

    const gmBody = document.createElement("div");
    const gmInst = await gmail.mount(gmBody, {
      uid: "gm-nb",
      settings: {},
      invoke: (async () => undefined) as WidgetContext["invoke"],
      setSettings: vi.fn(),
      onSettings: () => () => {},
      getSecret: vi.fn(async () => "ya29.tok"),
      setSecret: vi.fn(),
      deleteSecret: vi.fn(),
    });
    expect(gmBody.querySelector("[data-count]")?.textContent).toBe("…");
    gmInst.destroy?.();
    expect(abortObserved).toBe(true);

    const aiBody = document.createElement("div");
    const aiInst = await aiUsage.mount(aiBody, {
      uid: "ai-nb",
      settings: {},
      invoke: (() => new Promise(() => {})) as WidgetContext["invoke"],
      setSettings: vi.fn(),
      onSettings: () => () => {},
      getSecret: vi.fn(async () => null),
      setSecret: vi.fn(),
      deleteSecret: vi.fn(),
    });
    expect(typeof aiInst.destroy).toBe("function");
    aiInst.destroy?.();
  });

  it("redacts secrets, Bearer tokens, and tokenized URLs in errors, continues refresh after failure, and ignores late mount rejection", async () => {
    const { sanitizeSecretError } = await import("../core/credentials");

    const igErr = sanitizeSecretError(
      new Error("fetch failed https://graph.instagram.com/me?fields=followers_count&access_token=IG_SECRET_999"),
      ["IG_SECRET_999"],
    );
    expect(igErr).not.toContain("IG_SECRET_999");
    expect(igErr).toContain("access_token=[REDACTED]");

    const fhErr = sanitizeSecretError(
      new Error("fetch failed https://finnhub.io/api/v1/quote?symbol=AAPL&token=FH_SECRET_999"),
      ["FH_SECRET_999"],
    );
    expect(fhErr).not.toContain("FH_SECRET_999");
    expect(fhErr).toContain("token=[REDACTED]");

    const bearerErr = sanitizeSecretError(new Error("Authorization: Bearer ghp_SECRET_999 failed"));
    expect(bearerErr).not.toContain("ghp_SECRET_999");
    expect(bearerErr).toContain("Bearer [REDACTED]");

    // Late mount rejection after destroy does not log or paint error
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { registry } = await import("../core/registry");
    const { renderTile } = await import("../dock/tile");

    let rejectMount!: (err: unknown) => void;
    registry.register({
      id: "test-late-reject",
      name: "LateReject",
      group: "apps",
      icon: "",
      defaultSize: { w: 1, h: 1 },
      mount: () =>
        new Promise((_res, rej) => {
          rejectMount = rej;
        }),
    });
    const rejTile = renderTile({ uid: "lr-1", widgetId: "test-late-reject", size: { w: 1, h: 1 }, settings: {} });
    await Promise.resolve();
    (rejTile as unknown as { __destroy: () => void }).__destroy();
    rejectMount(new Error("boom with secret token=ABC"));
    await Promise.resolve();
    await Promise.resolve();
    expect(errSpy).not.toHaveBeenCalled();
    expect(rejTile.querySelector(".w-error")).toBeNull();

    // Throwing/rejecting refresh does not break subsequent auto-refresh scheduling
    vi.useFakeTimers();
    let refreshAttempts = 0;
    registry.register({
      id: "test-throw-refresh",
      name: "ThrowRefresh",
      group: "apps",
      icon: "",
      defaultSize: { w: 1, h: 1 },
      refreshMs: 500,
      mount: () => ({
        refresh: async () => {
          refreshAttempts += 1;
          if (refreshAttempts === 1) throw new Error("transient refresh error");
        },
      }),
    });
    const trTile = renderTile({ uid: "tr-1", widgetId: "test-throw-refresh", size: { w: 1, h: 1 }, settings: {} });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(refreshAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(refreshAttempts).toBe(2);
    (trTile as unknown as { __destroy: () => void }).__destroy();
  });
});

describe("F & C integration: own-property mappings, save-delete race, listen safety, and missing-IPC degradation", () => {
  it("treats Object.prototype keys like constructor and __proto__ as unknown widgets without crashing", async () => {
    storage.setItem(
      "lumdeck.state.v1",
      '{"layout":[{"uid":"unk-1","widgetId":"constructor","size":{"w":2,"h":1},"settings":{"token":"keep-plain"}},{"uid":"unk-2","widgetId":"__proto__","size":{"w":2,"h":1},"settings":{"label":"ok"}}]}',
    );

    const { getWidgetSecretMappings, extractLegacySecrets } = await import("../core/credentials");
    expect(getWidgetSecretMappings("constructor")).toEqual([]);
    expect(getWidgetSecretMappings("__proto__")).toEqual([]);
    expect(getWidgetSecretMappings("toString")).toEqual([]);
    expect(getWidgetSecretMappings("hasOwnProperty")).toEqual([]);
    expect(extractLegacySecrets("constructor", { token: "keep-plain" })).toEqual({
      cleanSettings: { token: "keep-plain" },
      legacySecrets: {},
    });

    const { store } = await import("../core/store");
    const { renderTile } = await import("../dock/tile");
    expect(store.get().layout.map((p) => [p.uid, p.widgetId])).toEqual([
      ["unk-1", "constructor"],
      ["unk-2", "__proto__"],
    ]);

    const t1 = renderTile(store.get().layout[0]);
    const t2 = renderTile(store.get().layout[1]);
    expect(t1.querySelector(".w-error")?.textContent).toContain("constructor");
    expect(t2.querySelector(".w-error")?.textContent).toContain("__proto__");
  });

  it("prevents deleted or deleting UIDs from queuing setSecret or legacy migration to recreate Vault entries", async () => {
    storage.setItem(
      "lumdeck.state.v1",
      JSON.stringify({
        layout: [
          { uid: "race-1", widgetId: "github-activity", size: { w: 2, h: 1 }, settings: { token: "old-pat" } },
          { uid: "race-tile", widgetId: "github-activity", size: { w: 2, h: 1 }, settings: {} },
        ],
      }),
    );

    let releaseDelete!: () => void;
    const entries = new Map<string, string>([
      ["race-1:token", "pat-1"],
      ["race-tile:token", "pat-tile"],
    ]);
    const calls: Array<{ cmd: string; key: string }> = [];
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
      const key = String(args?.key ?? "");
      calls.push({ cmd, key });
      if (cmd === "cred_delete" && key === "race-1:token") {
        await new Promise<void>((r) => {
          releaseDelete = r;
        });
        entries.delete(key);
        return undefined;
      }
      if (cmd === "cred_delete") {
        entries.delete(key);
        return undefined;
      }
      if (cmd === "cred_set") {
        entries.set(key, String(args?.secret ?? ""));
        return undefined;
      }
      if (cmd === "cred_get") {
        return entries.get(key) ?? null;
      }
      throw new Error(`unexpected ${cmd}`);
    }) as unknown as <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

    const { storeCredentialPort } = await import("../core/store");
    const { createCredentialManager, SecretVaultError } = await import("../core/credentials");
    const mgr = createCredentialManager({
      store: storeCredentialPort,
      invoke,
      isTauri: () => true,
    });

    // Start delete; concurrent setSecret and getSecret must NOT queue cred_set
    const delPromise = mgr.deleteWidgetSecrets("race-1", "github-activity");
    await expect(mgr.setSecret("race-1", "github-activity", "token", "new-pat")).rejects.toMatchObject({
      name: "SecretVaultError",
      code: "widget_deleted",
    });
    expect(await mgr.getSecret("race-1", "github-activity", "token")).toBeNull();

    releaseDelete();
    await delPromise;
    expect(entries.has("race-1:token")).toBe(false);
    expect(calls.some((c) => c.cmd === "cred_set" && c.key === "race-1:token")).toBe(false);

    // Late write after delete completion also rejects cleanly without recreating Vault
    await expect(mgr.setSecret("race-1", "github-activity", "token", "late-pat")).rejects.toBeInstanceOf(
      SecretVaultError,
    );
    expect(entries.has("race-1:token")).toBe(false);

    // Tile-level save vs remove race when deleteWidgetSecrets + store.removeWidget complete
    vi.resetModules();
    vi.doMock("../core/tauri", () => ({
      hasTauri: true,
      isTauri: () => true,
      classifyIpcUnavailable: () => null,
      invoke,
      listen: () => () => {},
    }));
    const { store } = await import("../core/store");
    const { registry } = await import("../core/registry");
    let capturedCtx!: WidgetContext;
    registry.register({
      id: "github-activity",
      name: "Race",
      group: "analytics",
      icon: "",
      defaultSize: { w: 2, h: 1 },
      mount: (_body, ctx) => {
        capturedCtx = ctx;
        return {};
      },
    });
    const { renderTile } = await import("../dock/tile");
    const placed = store.get().layout[1];
    const tile = renderTile(placed);
    await Promise.resolve();

    tile.querySelector<HTMLButtonElement>(".tile-remove")!.click();
    await expect(capturedCtx.setSecret("token", "recreated")).rejects.toMatchObject({
      code: "widget_deleted",
    });
    await vi.waitFor(() => expect(store.get().layout.map((p) => p.uid)).not.toContain("race-tile"));
    expect(entries.has("race-tile:token")).toBe(false);
    expect(calls.some((c) => c.cmd === "cred_set" && c.key === "race-tile:token")).toBe(false);
  });

  it("core/tauri listen catches rejections without leaking secrets, deduplicates logs, and honors unsubscribe", async () => {
    (window as unknown as Record<string, unknown>).__TAURI__ = {};
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const eventMockState: {
      impl: (ev: string, cb: (e: { payload: string }) => void) => Promise<() => void>;
    } = {
      impl: async () => {
        throw new Error("permission denied token=SECRET_VALUE_SHOULD_NOT_LOG");
      },
    };
    const mockTauriListen = vi.fn(
      (ev: string, cb: (e: { payload: string }) => void) => eventMockState.impl(ev, cb),
    );
    const eventModuleMock = { listen: mockTauriListen };
    vi.doMock("@tauri-apps/api/event", () => eventModuleMock);

    const { listen } = await import("../core/tauri");
    const handler = vi.fn();
    const unsub1 = listen("tray:widgets", handler);
    const unsub2 = listen("tray:widgets", handler);

    await vi.waitFor(() => expect(mockTauriListen).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    await Promise.resolve();

    expect(warnSpy.mock.calls).toEqual([
      ["[lumdeck] tauri.listen failed", { op: "listen", event: "tray:widgets", category: "Error" }],
    ]);

    const logged = JSON.stringify(warnSpy.mock.calls);
    expect(logged).toContain("tray:widgets");
    expect(logged).toContain("Error");
    expect(logged).not.toContain("SECRET_VALUE_SHOULD_NOT_LOG");
    expect(handler).not.toHaveBeenCalled();
    unsub1();
    unsub2();

    // Arbitrary Error.name / err.message must map to a fixed safe category without leaking
    warnSpy.mockClear();
    mockTauriListen.mockClear();
    eventMockState.impl = async () => {
      const err = new Error("SECRET_MESSAGE_LEAK");
      err.name = "SECRET_ERROR_NAME_LEAK";
      throw err;
    };
    const unsubCustom1 = listen("tray:custom-err", handler);
    const unsubCustom2 = listen("tray:custom-err", handler);
    await vi.waitFor(() => expect(mockTauriListen).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    await Promise.resolve();
    expect(warnSpy.mock.calls).toEqual([
      ["[lumdeck] tauri.listen failed", { op: "listen", event: "tray:custom-err", category: "Error" }],
    ]);
    const customLogged = JSON.stringify(warnSpy.mock.calls);
    expect(customLogged).not.toContain("SECRET_ERROR_NAME_LEAK");
    expect(customLogged).not.toContain("SECRET_MESSAGE_LEAK");
    unsubCustom1();
    unsubCustom2();

    // Unsubscribe before async listen resolves prevents handler invocation and runs late unlisten
    mockTauriListen.mockClear();
    let emitLate!: (e: { payload: string }) => void;
    const lateUnlisten = vi.fn();
    let resolveListen!: (fn: () => void) => void;
    eventMockState.impl = (_ev, cb) => {
      emitLate = cb;
      return new Promise<() => void>((r) => {
        resolveListen = r;
      });
    };

    const lateHandler = vi.fn();
    const stop = listen<string>("tray:settings", lateHandler);
    await vi.waitFor(() => expect(mockTauriListen).toHaveBeenCalledTimes(1));
    expect(resolveListen).toBeTypeOf("function");
    stop();
    resolveListen(lateUnlisten);
    await vi.waitFor(() => expect(lateUnlisten).toHaveBeenCalledTimes(1));
    emitLate({ payload: "ignored" });
    expect(lateHandler).not.toHaveBeenCalled();

    // Unsubscribe synchronously before dynamic import settles skips native registration
    mockTauriListen.mockClear();
    const earlyHandler = vi.fn();
    const stopEarly = listen<string>("tray:settings", earlyHandler);
    stopEarly();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(mockTauriListen).not.toHaveBeenCalled();
    expect(earlyHandler).not.toHaveBeenCalled();

    vi.doUnmock("@tauri-apps/api/event");
  });

  it("degrades AI Usage, Now Playing, Volume, and Brightness on missing native IPC or browser preview without repeated calls or collecting credentials", async () => {
    storage.setItem(
      "lumdeck.state.v1",
      JSON.stringify({
        layout: [
          { uid: "ai-mig", widgetId: "ai-usage", size: { w: 3, h: 1 }, settings: { sessionKey: "legacy-ai-secret", provider: "claude" } },
        ],
      }),
    );

    const vault = createMockVault();
    const { store, storeCredentialPort } = await import("../core/store");
    const { createCredentialManager } = await import("../core/credentials");
    const mgr = createCredentialManager({
      store: storeCredentialPort,
      invoke: vault.invoke,
      isTauri: () => true,
    });
    const secretHandle = mgr.forWidget("ai-mig", "ai-usage");

    // 1. AI Usage: preserves UID/layout/Vault migration, degrades on missing command, never shows connect form or re-polls
    const aiMod = (await import("../widgets/ai/ai-usage.widget")).default;
    const aiInvoke = vi.fn(async (cmd: string) => {
      throw new Error(`Command ${cmd} not found`);
    });
    const aiBody = document.createElement("div");
    const aiInst = await aiMod.mount(aiBody, {
      uid: "ai-mig",
      settings: store.widgetSettings("ai-mig"),
      invoke: aiInvoke as WidgetContext["invoke"],
      setSettings: (p) => store.setWidgetSettings("ai-mig", p),
      onSettings: () => () => {},
      ...secretHandle,
    });
    await vi.waitFor(() => expect(aiBody.textContent).toContain("not available in this build"));
    expect(vault.entries.get("ai-mig:sessionKey")).toBe("legacy-ai-secret");
    expect(store.get().layout.map((p) => p.uid)).toEqual(["ai-mig"]);
    expect(aiBody.querySelector("[data-token]")).toBeNull();
    expect(aiBody.querySelector("[data-connect]")).toBeNull();
    expect(aiInvoke).toHaveBeenCalledTimes(1);

    await aiInst.refresh?.();
    const secondChip = aiBody.querySelectorAll<HTMLButtonElement>("[data-chips] button")[1];
    secondChip?.click();
    await Promise.resolve();
    expect(aiInvoke).toHaveBeenCalledTimes(1);
    aiInst.destroy?.();

    // 2. Now Playing: distinguishes browser preview vs native missing, disables controls, stops polling
    const npMod = (await import("../widgets/media/now-playing.widget")).default;
    const npInvoke = vi.fn(async (cmd: string) => {
      throw new Error(`Tauri unavailable (command "${cmd}" called outside the app)`);
    });
    const npBody = document.createElement("div");
    const npInst = await npMod.mount(npBody, {
      uid: "np-1",
      settings: {},
      invoke: npInvoke as WidgetContext["invoke"],
      setSettings: vi.fn(),
      onSettings: () => () => {},
      getSecret: vi.fn(async () => null),
      setSecret: vi.fn(),
      deleteSecret: vi.fn(),
    });
    await vi.waitFor(() => expect(npBody.textContent).toContain("browser preview"));
    expect(npInvoke).toHaveBeenCalledTimes(1);
    await npInst.refresh?.();
    npBody.querySelector<HTMLButtonElement>("[data-toggle]")?.click();
    expect(npInvoke).toHaveBeenCalledTimes(1);
    npInst.destroy?.();

    // 3. Volume: stops polling/controls after missing command
    const volMod = (await import("../widgets/system/volume.widget")).default;
    const volInvoke = vi.fn(async (cmd: string) => {
      throw new Error(`Command ${cmd} not found`);
    });
    const volBody = document.createElement("div");
    const volInst = await volMod.mount(volBody, {
      uid: "vol-1",
      settings: {},
      invoke: volInvoke as WidgetContext["invoke"],
      setSettings: vi.fn(),
      onSettings: () => () => {},
      getSecret: vi.fn(async () => null),
      setSecret: vi.fn(),
      deleteSecret: vi.fn(),
    });
    expect(volBody.textContent).toContain("not available in this build");
    expect(volInvoke).toHaveBeenCalledTimes(1);
    await volInst.refresh?.();
    expect(volInvoke).toHaveBeenCalledTimes(1);
    volInst.destroy?.();

    // 4. Brightness: keeps slider disabled and degrades cleanly without calling brightness_set
    const brMod = (await import("../widgets/system/brightness.widget")).default;
    const brInvoke = vi.fn(async (cmd: string) => {
      throw new Error(`Command ${cmd} not found`);
    });
    const brBody = document.createElement("div");
    const brInst = await brMod.mount(brBody, {
      uid: "br-1",
      settings: {},
      invoke: brInvoke as WidgetContext["invoke"],
      setSettings: vi.fn(),
      onSettings: () => () => {},
      getSecret: vi.fn(async () => null),
      setSecret: vi.fn(),
      deleteSecret: vi.fn(),
    });
    await vi.waitFor(() => expect(brBody.textContent).toContain("not available in this build"));
    expect(brInvoke).toHaveBeenCalledTimes(1);
    expect(brInvoke).toHaveBeenCalledWith("brightness_get");
    brInst.destroy?.();
  });
});
