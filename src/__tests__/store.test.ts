import { describe, it, expect, beforeEach, vi } from "vitest";

// store.ts reads localStorage at module-init and uses the bare global, which is
// unreliable under the jsdom test env. Install a working in-memory Storage and
// reset + re-import the module per test so load() re-runs against it.
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
  const w = (globalThis as unknown as { window?: { localStorage: unknown } }).window;
  if (w) w.localStorage = s;
  vi.resetModules();
});

describe("store persistence validation (P0 fix: malformed layout must not brick boot)", () => {
  it("drops malformed layout entries and normalizes/clamps sizes", async () => {
    localStorage.setItem(
      "lumdeck.state.v1",
      JSON.stringify({
        style: "not-a-style",
        size: "xl",
        edge: "left",
        autoHideTaskbar: "yes",
        layout: [
          { uid: "a", widgetId: "clock-digital", size: { w: 2, h: 1 }, settings: {} },
          { widgetId: "missing-uid" }, // no uid -> dropped
          { uid: "c", widgetId: "system-stats" }, // no size -> normalized
          null,
          "nope",
          { uid: "d", widgetId: "todo-list", size: { w: 99, h: 9 }, settings: { x: 1 } }, // clamped
        ],
      }),
    );
    const { store } = await import("../core/store");
    const s = store.get();
    expect(s.style).toBe("liquid"); // invalid enum -> default
    expect(s.size).toBe("md");
    expect(s.edge).toBe("bottom");
    expect(s.autoHideTaskbar).toBe(false); // non-boolean -> default
    expect(s.layout.map((p) => p.uid)).toEqual(["a", "c", "d"]);
    expect(s.layout[1].size).toEqual({ w: 2, h: 1 });
    expect(s.layout[2].size).toEqual({ w: 6, h: 4 });
    expect(s.layout[2].settings).toEqual({ x: 1 });
  });

  it("falls back to defaults on corrupt JSON", async () => {
    localStorage.setItem("lumdeck.state.v1", "{ this is not valid json");
    const { store } = await import("../core/store");
    expect(store.get().layout).toEqual([]);
    expect(store.get().style).toBe("liquid");
  });

  it("setPrefs rejects invalid enum values", async () => {
    const { store } = await import("../core/store");
    store.setPrefs({ style: "hacked" as never, edge: "diagonal" as never });
    expect(store.get().style).toBe("liquid");
    expect(store.get().edge).toBe("bottom");
  });
});
