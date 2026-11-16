import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { WidgetContext } from "../core/types";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
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

beforeEach(() => {
  const s = new MemStorage();
  (globalThis as unknown as { localStorage: MemStorage }).localStorage = s;
  if (typeof window !== "undefined") {
    (window as unknown as { localStorage: MemStorage }).localStorage = s;
  }
  document.body.innerHTML = `<div id="app"></div>`;
  delete (window as unknown as Record<string, unknown>).__TAURI__;
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.resetModules();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("../core/tauri");
  document.body.innerHTML = "";
});

describe("B3/B1 dock positioning and quit IPC", () => {
  it("skips reposition on settings-only updates, tracks edge/size/DPR, and coalesces in-flight calls", async () => {
    const invokeSpy = vi.fn<(cmd: string, args?: unknown) => Promise<void>>(async () => undefined);
    const dprListeners = new Set<() => void>();
    let currentDpr = 1;
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      get: () => currentDpr,
    });
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: (_ev: string, fn: () => void) => dprListeners.add(fn),
        removeEventListener: (_ev: string, fn: () => void) => dprListeners.delete(fn),
      })),
    );
    vi.doMock("../core/tauri", () => ({
      hasTauri: true,
      invoke: invokeSpy,
      listen: () => () => {},
    }));

    const { store } = await import("../core/store");
    store.setLayout([
      { uid: "n1", widgetId: "notes", size: { w: 2, h: 1 }, settings: { text: "hi" } },
      { uid: "c1", widgetId: "clock-digital", size: { w: 2, h: 1 }, settings: {} },
    ]);

    const { boot } = await import("../dock/dock");
    boot();
    await vi.waitFor(() =>
      expect(invokeSpy).toHaveBeenCalledWith("dock_position", { edge: "bottom", heightPx: 88 }),
    );
    invokeSpy.mockClear();

    // Settings-only, style, and reorder updates must produce 0 dock_position IPC calls.
    store.setWidgetSettings("n1", { text: "updated note body" });
    store.setPrefs({ style: "midnight" });
    store.setPrefs({ autoHideTaskbar: true });
    store.moveWidget(0, 1);
    await Promise.resolve();
    const posCallsAfterSettingsOnly = invokeSpy.mock.calls.filter(([c]) => c === "dock_position");
    expect(posCallsAfterSettingsOnly).toHaveLength(0);

    // Changing edge and size updates geometry and heightPx.
    store.setPrefs({ edge: "top" });
    await vi.waitFor(() =>
      expect(invokeSpy).toHaveBeenCalledWith("dock_position", { edge: "top", heightPx: 88 }),
    );
    invokeSpy.mockClear();

    // Re-setting the same edge triggers 0 duplicate calls.
    store.setPrefs({ edge: "top" });
    await Promise.resolve();
    expect(invokeSpy).not.toHaveBeenCalled();

    // Coalescing: hold first in-flight dock_position while queuing multiple updates.
    let releaseFirst!: () => void;
    invokeSpy.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    store.setPrefs({ size: "sm" });
    store.setPrefs({ size: "lg" });
    store.setPrefs({ edge: "bottom" });
    expect(invokeSpy).toHaveBeenCalledTimes(1);
    expect(invokeSpy).toHaveBeenLastCalledWith("dock_position", { edge: "top", heightPx: 70 });

    releaseFirst();
    await vi.waitFor(() => expect(invokeSpy).toHaveBeenCalledTimes(2));
    expect(invokeSpy).toHaveBeenLastCalledWith("dock_position", { edge: "bottom", heightPx: 108 });
    invokeSpy.mockClear();

    // DPR / scale change triggers dock_position even with identical edge/size.
    currentDpr = 1.5;
    for (const fn of [...dprListeners]) fn();
    await vi.waitFor(() =>
      expect(invokeSpy).toHaveBeenCalledWith("dock_position", { edge: "bottom", heightPx: 108 }),
    );
  });

  it("routes context menu Quit LumDeck to quit_app in Tauri and window.close in browser preview", async () => {
    const invokeSpy = vi.fn<(cmd: string, args?: unknown) => Promise<void>>(async () => undefined);
    vi.doMock("../core/tauri", () => ({
      hasTauri: true,
      invoke: invokeSpy,
      listen: () => () => {},
    }));

    const { boot } = await import("../dock/dock");
    boot();
    invokeSpy.mockClear();

    const dockEl = document.getElementById("dock")!;
    dockEl.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));
    const quitBtn = [...document.querySelectorAll<HTMLButtonElement>(".ctx button")].find((b) =>
      b.textContent?.includes("Quit LumDeck"),
    );
    expect(quitBtn).toBeTruthy();
    quitBtn!.click();

    await vi.waitFor(() => expect(invokeSpy).toHaveBeenCalledWith("quit_app"));
    expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === "taskbar_autohide")).toHaveLength(0);

    // Browser preview degrades to window.close without invoking quit_app.
    vi.resetModules();
    vi.doUnmock("../core/tauri");
    const closeSpy = vi.fn();
    vi.stubGlobal("close", closeSpy);
    const browserInvoke = vi.fn(async () => {
      throw new Error("should not be called");
    });
    vi.doMock("../core/tauri", () => ({
      hasTauri: false,
      invoke: browserInvoke,
      listen: () => () => {},
    }));
    document.body.innerHTML = `<div id="app"></div>`;
    const { boot: bootBrowser } = await import("../dock/dock");
    bootBrowser();
    document.getElementById("dock")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    const browserQuit = [...document.querySelectorAll<HTMLButtonElement>(".ctx button")].find((b) =>
      b.textContent?.includes("Quit LumDeck"),
    );
    browserQuit!.click();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(browserInvoke).not.toHaveBeenCalled();
  });
});

describe("B1 settings auto-hide confirmation", () => {
  it("awaits taskbar_autohide success before confirming and keeps prior state with error on failure", async () => {
    let resolveNext!: () => void;
    let rejectNext!: (e: Error) => void;
    const invokeSpy = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((res) => {
            resolveNext = res;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((_res, rej) => {
            rejectNext = rej;
          }),
      );

    vi.doMock("../core/tauri", () => ({
      hasTauri: true,
      invoke: invokeSpy,
      listen: () => () => {},
    }));

    const { store } = await import("../core/store");
    const { openSettings } = await import("../ui/settings");
    openSettings();

    const sw = document.querySelector<HTMLButtonElement>(".switch")!;
    expect(sw.classList.contains("on")).toBe(false);

    // Click to enable: state must not flip until IPC resolves.
    sw.click();
    expect(sw.disabled).toBe(true);
    expect(store.get().autoHideTaskbar).toBe(false);
    expect(sw.classList.contains("on")).toBe(false);
    expect(invokeSpy).toHaveBeenCalledWith("taskbar_autohide", { enabled: true });

    resolveNext();
    await vi.waitFor(() => expect(sw.disabled).toBe(false));
    expect(store.get().autoHideTaskbar).toBe(true);
    expect(sw.classList.contains("on")).toBe(true);

    // Click to disable, then fail: must preserve enabled=true and render short error.
    sw.click();
    rejectNext(new Error("could not write taskbar auto-hide"));
    await vi.waitFor(() => expect(sw.disabled).toBe(false));
    expect(store.get().autoHideTaskbar).toBe(true);
    expect(sw.classList.contains("on")).toBe(true);
    const errEl = document.querySelector<HTMLElement>("[data-taskbar-error]")!;
    expect(errEl.style.display).not.toBe("none");
    expect(errEl.textContent).toContain("could not write taskbar auto-hide");
  });

  it("degrades in browser preview when hasTauri is false", async () => {
    const invokeSpy = vi.fn(async () => {
      throw new Error("Tauri unavailable");
    });
    vi.doMock("../core/tauri", () => ({
      hasTauri: false,
      invoke: invokeSpy,
      listen: () => () => {},
    }));

    const { store } = await import("../core/store");
    const { openSettings } = await import("../ui/settings");
    openSettings();

    const sw = document.querySelector<HTMLButtonElement>(".switch")!;
    sw.click();
    await vi.waitFor(() => expect(store.get().autoHideTaskbar).toBe(true));
    expect(sw.classList.contains("on")).toBe(true);
    expect(invokeSpy).not.toHaveBeenCalled();
  });
});

describe("B4 Hacker News validated external links", () => {
  it("sanitizes upstream URLs, falls back to validated HN item URL, and invokes open_web_url", async () => {
    (window as unknown as Record<string, unknown>).__TAURI__ = {};
    const stories: Record<number, { id: number; title: string; url?: string; score: number }> = {
      101: { id: 101, title: "Valid HTTPS", url: "https://example.com/post?a=1", score: 50 },
      102: { id: 102, title: "File Scheme", url: "file:///C:/Windows/System32/cmd.exe", score: 40 },
      103: { id: 103, title: "JS Scheme", url: "javascript:alert(1)", score: 30 },
      104: { id: 104, title: "MS Settings", url: "ms-settings:windowsupdate", score: 20 },
      105: { id: 105, title: "UNC Path", url: "\\\\attacker\\share\\evil.exe", score: 10 },
      106: { id: 106, title: "Userinfo URL", url: "https://user:pass@example.com/a", score: 5 },
    };
    const ids = Object.keys(stories).map(Number);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const u = String(url);
        const body = u.includes("topstories")
          ? ids
          : stories[Number(/item\/(\d+)\.json/.exec(u)?.[1] ?? 0)];
        return {
          ok: true,
          status: 200,
          json: async () => body,
        } as unknown as Response;
      }),
    );

    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);

    const invokeSpy = vi.fn(async () => undefined);
    const ctx = {
      uid: "hn-1",
      settings: {},
      invoke: invokeSpy,
      setSettings: vi.fn(),
      onSettings: () => () => {},
      setSecret: vi.fn(async () => {}),
      getSecret: vi.fn(async () => null),
      deleteSecret: vi.fn(async () => {}),
    } as unknown as WidgetContext;

    const mod = (await import("../widgets/online/hackernews-top.widget")).default;
    const body = document.createElement("div");
    await mod.mount(body, ctx);

    await vi.waitFor(() => {
      expect(body.querySelectorAll("[data-url]")).toHaveLength(6);
    });

    const items = [...body.querySelectorAll<HTMLElement>("[data-url]")];
    expect(items.map((el) => el.dataset.url)).toEqual([
      "https://example.com/post?a=1",
      "https://news.ycombinator.com/item?id=102",
      "https://news.ycombinator.com/item?id=103",
      "https://news.ycombinator.com/item?id=104",
      "https://news.ycombinator.com/item?id=105",
      "https://news.ycombinator.com/item?id=106",
    ]);

    items[0].click();
    items[1].click();
    await vi.waitFor(() => expect(invokeSpy).toHaveBeenCalledTimes(2));
    expect(invokeSpy).toHaveBeenNthCalledWith(1, "open_web_url", {
      url: "https://example.com/post?a=1",
    });
    expect(invokeSpy).toHaveBeenNthCalledWith(2, "open_web_url", {
      url: "https://news.ycombinator.com/item?id=102",
    });
    expect(openSpy).not.toHaveBeenCalled();

    // Even if open_web_url rejects inside Tauri, never fall back to window.open.
    invokeSpy.mockRejectedValueOnce(new Error("rejected"));
    items[0].click();
    await Promise.resolve();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("uses validated window.open only in browser preview", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const u = String(url);
        const body = u.includes("topstories")
          ? [201]
          : { id: 201, title: "Browser Story", url: "https://example.org/news", score: 12 };
        return { ok: true, status: 200, json: async () => body } as unknown as Response;
      }),
    );
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);

    const ctx = {
      uid: "hn-2",
      settings: {},
      invoke: vi.fn(async () => {
        throw new Error("Tauri unavailable");
      }),
      setSettings: vi.fn(),
      onSettings: () => () => {},
      setSecret: vi.fn(async () => {}),
      getSecret: vi.fn(async () => null),
      deleteSecret: vi.fn(async () => {}),
    } as unknown as WidgetContext;

    const mod = (await import("../widgets/online/hackernews-top.widget")).default;
    const body = document.createElement("div");
    await mod.mount(body, ctx);

    const link = await vi.waitFor(() => {
      const el = body.querySelector<HTMLElement>("[data-url]");
      expect(el).not.toBeNull();
      return el!;
    });
    link.click();
    await vi.waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith("https://example.org/news", "_blank", "noopener"),
    );
  });
});
