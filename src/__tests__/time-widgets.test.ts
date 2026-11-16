import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsBag, WidgetContext } from "../core/types";
import worldClockWidget from "../widgets/clocks/world-clock.widget";
import pomodoroWidget from "../widgets/productivity/pomodoro.widget";
import timerWidget from "../widgets/productivity/timer.widget";

function makeCtx(initialSettings: SettingsBag = {}) {
  const settings: SettingsBag = { ...initialSettings };
  const listeners = new Set<(s: SettingsBag) => void>();
  const setSettings = vi.fn((patch: SettingsBag) => {
    Object.assign(settings, patch);
    const snap = { ...settings };
    for (const fn of listeners) fn(snap);
  });
  const ctx: WidgetContext = {
    uid: "test-uid",
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
      const snap = { ...settings };
      for (const fn of listeners) fn(snap);
    },
  };
}

function refCityTime(tz: string, now: Date): { time: string; day: string } {
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
  const local = Date.parse(new Intl.DateTimeFormat("en-CA").format(now));
  const remote = Date.parse(new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now));
  const diff = Math.round((remote - local) / 86400000);
  const day = diff === 0 ? "" : diff > 0 ? `+${diff}d` : `${diff}d`;
  return { time, day };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("timer widget (deadline settlement)", () => {
  it("preserves elapsed time across repeated 199ms pauses before the 200ms tick", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-16T10:00:00.000Z"));

    const body = document.createElement("div");
    const { ctx } = makeCtx({ minutes: 5 });
    const inst = timerWidget.mount(body, ctx) as { destroy?: () => void };

    const toggleBtn = body.querySelector<HTMLButtonElement>("[data-toggle]")!;
    const timeEl = body.querySelector<HTMLElement>("[data-time]")!;
    const statusEl = body.querySelector<HTMLElement>("[data-status]")!;
    const barEl = body.querySelector<HTMLElement>("[data-bar]")!;

    expect(timeEl.textContent).toBe("05:00");
    expect(statusEl.textContent).toBe("ready");

    // 6 x 199ms = 1194ms elapsed without ever firing the 200ms interval tick
    for (let i = 0; i < 6; i++) {
      toggleBtn.click(); // Start
      vi.advanceTimersByTime(199);
      toggleBtn.click(); // Pause before 200ms tick
    }

    expect(statusEl.textContent).toBe("ready");
    expect(toggleBtn.textContent).toContain("Start");
    // 300_000 - 1194 = 298_806ms -> ceil(298.806) = 299s = 04:59
    expect(timeEl.textContent).toBe("04:59");
    expect(barEl.style.width).toBe("99.6%");

    // Resuming finishes from the settled remaining time (298_806ms)
    toggleBtn.click();
    vi.advanceTimersByTime(298_800);
    expect(statusEl.textContent).toBe("running");
    vi.advanceTimersByTime(200);
    expect(timeEl.textContent).toBe("00:00");
    expect(statusEl.textContent).toBe("time's up");
    expect(toggleBtn.textContent).toContain("Again");

    inst.destroy?.();
  });

  it("settles to done once when paused after the deadline due to late event loop", () => {
    vi.useFakeTimers();
    const start = new Date("2026-11-16T10:00:00.000Z").getTime();
    vi.setSystemTime(start);

    const body = document.createElement("div");
    const { ctx } = makeCtx({ minutes: 1 });
    const inst = timerWidget.mount(body, ctx) as { destroy?: () => void };

    const toggleBtn = body.querySelector<HTMLButtonElement>("[data-toggle]")!;
    const timeEl = body.querySelector<HTMLElement>("[data-time]")!;
    const statusEl = body.querySelector<HTMLElement>("[data-status]")!;
    const resetBtn = body.querySelector<HTMLButtonElement>("[data-reset]")!;

    toggleBtn.click(); // Start 60_000ms timer
    expect(statusEl.textContent).toBe("running");

    // Simulate event loop stall jumping past deadline before interval ticks
    vi.setSystemTime(start + 60_500);
    toggleBtn.click(); // User hits Pause late

    expect(timeEl.textContent).toBe("00:00");
    expect(statusEl.textContent).toBe("time's up");
    expect(toggleBtn.textContent).toContain("Again");
    expect(timeEl.classList.contains("lum-timer-done")).toBe(true);

    // Further timer progression while stopped does not alter finished state
    vi.advanceTimersByTime(5000);
    expect(timeEl.textContent).toBe("00:00");
    expect(statusEl.textContent).toBe("time's up");

    // Clicking Again starts a new countdown; Reset cancels cleanly
    toggleBtn.click();
    expect(statusEl.textContent).toBe("running");
    expect(timeEl.textContent).toBe("01:00");

    resetBtn.click();
    expect(statusEl.textContent).toBe("ready");
    expect(timeEl.textContent).toBe("01:00");
    expect(toggleBtn.textContent).toContain("Start");

    inst.destroy?.();
  });
});

describe("pomodoro widget (deadline settlement & phase transitions)", () => {
  it("preserves elapsed time across repeated 249ms pauses before the 250ms tick", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-16T10:00:00.000Z"));

    const body = document.createElement("div");
    const { ctx, setSettings } = makeCtx({ workMin: 1, breakMin: 5 });
    const inst = pomodoroWidget.mount(body, ctx) as { destroy?: () => void };

    const toggleBtn = body.querySelector<HTMLButtonElement>("[data-toggle]")!;
    const timeEl = body.querySelector<HTMLElement>("[data-time]")!;
    const modeEl = body.querySelector<HTMLElement>("[data-mode]")!;
    const countEl = body.querySelector<HTMLElement>("[data-count]")!;

    // 5 x 249ms = 1245ms elapsed without firing the 250ms interval tick
    for (let i = 0; i < 5; i++) {
      toggleBtn.click(); // Start
      vi.advanceTimersByTime(249);
      toggleBtn.click(); // Pause before 250ms tick
    }

    // 60_000 - 1245 = 58_755ms -> ceil = 59s = 00:59
    expect(timeEl.textContent).toBe("00:59");
    expect(modeEl.textContent).toBe("Focus");
    expect(countEl.textContent).toBe("0 today");
    expect(toggleBtn.textContent).toContain("Start");
    expect(setSettings).not.toHaveBeenCalled();

    // Remaining 58_755ms: at 58_750ms 5ms remain (Focus), next tick at 59_000ms finishes work
    toggleBtn.click();
    vi.advanceTimersByTime(58_750);
    expect(modeEl.textContent).toBe("Focus");
    expect(timeEl.textContent).toBe("00:01");
    expect(countEl.textContent).toBe("0 today");

    vi.advanceTimersByTime(250);
    expect(modeEl.textContent).toBe("Break");
    expect(countEl.textContent).toBe("1 today");
    expect(timeEl.textContent).toBe("05:00");
    expect(setSettings).toHaveBeenCalledTimes(1);

    inst.destroy?.();
  });

  it("counts work completion once and pauses in Break when paused late past deadline", () => {
    vi.useFakeTimers();
    const start = new Date("2026-11-16T10:00:00.000Z").getTime();
    vi.setSystemTime(start);

    const body = document.createElement("div");
    const { ctx, setSettings } = makeCtx({ workMin: 1, breakMin: 2 });
    const inst = pomodoroWidget.mount(body, ctx) as { destroy?: () => void };

    const toggleBtn = body.querySelector<HTMLButtonElement>("[data-toggle]")!;
    const timeEl = body.querySelector<HTMLElement>("[data-time]")!;
    const modeEl = body.querySelector<HTMLElement>("[data-mode]")!;
    const countEl = body.querySelector<HTMLElement>("[data-count]")!;
    const resetBtn = body.querySelector<HTMLButtonElement>("[data-reset]")!;

    toggleBtn.click(); // Start Focus

    // Event loop jumps past 60_000ms deadline before tick runs, then user pauses
    vi.setSystemTime(start + 60_500);
    toggleBtn.click();

    expect(modeEl.textContent).toBe("Break");
    expect(countEl.textContent).toBe("1 today");
    expect(timeEl.textContent).toBe("02:00");
    expect(toggleBtn.textContent).toContain("Start"); // stays paused as requested
    expect(setSettings).toHaveBeenCalledTimes(1);

    // Advancing timers while paused must not double-count
    vi.advanceTimersByTime(10_000);
    expect(countEl.textContent).toBe("1 today");
    expect(setSettings).toHaveBeenCalledTimes(1);

    // Resuming Break and finishing Break returns to Focus without incrementing count
    toggleBtn.click();
    vi.advanceTimersByTime(120_000);
    expect(modeEl.textContent).toBe("Focus");
    expect(countEl.textContent).toBe("1 today");
    expect(timeEl.textContent).toBe("01:00");
    expect(setSettings).toHaveBeenCalledTimes(1);

    // Manual reset stops and restores Focus phase without changing count
    resetBtn.click();
    expect(modeEl.textContent).toBe("Focus");
    expect(toggleBtn.textContent).toContain("Start");
    expect(timeEl.textContent).toBe("01:00");
    expect(countEl.textContent).toBe("1 today");

    inst.destroy?.();
  });

  it("counts once when late tick fires before pause and resets daily count across midnight", () => {
    vi.useFakeTimers();
    const start = new Date(2026, 10, 16, 23, 59, 30, 0).getTime();
    vi.setSystemTime(start);

    const body = document.createElement("div");
    const { ctx, setSettings } = makeCtx({
      workMin: 1,
      breakMin: 1,
      date: "2026-11-16",
      count: 3,
    });
    const inst = pomodoroWidget.mount(body, ctx) as { destroy?: () => void };

    const toggleBtn = body.querySelector<HTMLButtonElement>("[data-toggle]")!;
    const countEl = body.querySelector<HTMLElement>("[data-count]")!;
    const modeEl = body.querySelector<HTMLElement>("[data-mode]")!;

    expect(countEl.textContent).toBe("3 today");
    toggleBtn.click(); // Start at 23:59:30 (crosses midnight during this 1m Focus)

    // Jump clock past deadline across midnight, run tick once, then pause immediately
    vi.setSystemTime(start + 60_400);
    vi.advanceTimersByTime(250);
    expect(modeEl.textContent).toBe("Break");
    expect(countEl.textContent).toBe("1 today"); // rolled over to 2026-11-17 (0 -> 1)
    expect(setSettings).toHaveBeenCalledWith({ count: 1, date: "2026-11-17" });

    toggleBtn.click(); // Pause right after tick
    expect(countEl.textContent).toBe("1 today");
    expect(setSettings).toHaveBeenCalledTimes(1);

    inst.destroy?.();
  });
});

describe("world-clock widget (empty list, caching, DOM updates, DST & midnight)", () => {
  it("preserves an explicit empty city list across deletions, reload, and onSettings", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-16T12:00:00.000Z"));

    const body = document.createElement("div");
    const { ctx, settings, setSettings, emitSettings } = makeCtx();
    const inst = worldClockWidget.mount(body, ctx) as { destroy?: () => void };

    const listEl = body.querySelector<HTMLElement>("[data-list]")!;
    const addBtn = body.querySelector<HTMLButtonElement>("[data-add]")!;

    // Default seed when cities is unset
    expect(listEl.children.length).toBe(3);

    // Delete all 3 cities one by one
    while (listEl.querySelector("button")) {
      listEl.querySelector<HTMLButtonElement>("button")!.click();
    }
    expect(listEl.children.length).toBe(0);
    expect(addBtn.disabled).toBe(false);
    expect(settings.cities).toEqual([]);
    expect(setSettings).toHaveBeenLastCalledWith({ cities: [] });
    inst.destroy?.();

    // Reload / remount with persisted empty array must NOT fall back to defaults
    const reloadedBody = document.createElement("div");
    const reloaded = makeCtx({ cities: settings.cities });
    const inst2 = worldClockWidget.mount(reloadedBody, reloaded.ctx) as {
      refresh?: () => void;
      destroy?: () => void;
    };
    expect(reloadedBody.querySelector<HTMLElement>("[data-list]")!.children.length).toBe(0);

    // External onSettings update can add and again clear to []
    reloaded.emitSettings({ cities: [{ name: "Paris", tz: "Europe/Paris" }] });
    expect(reloadedBody.querySelector<HTMLElement>("[data-list]")!.children.length).toBe(1);
    reloaded.emitSettings({ cities: [] });
    expect(reloadedBody.querySelector<HTMLElement>("[data-list]")!.children.length).toBe(0);

    inst2.destroy?.();
  });

  it("caches valid timezone formatters, evicts removed zones, and skips unchanged DOM writes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-16T12:00:10.000Z"));

    const RealDTF = Intl.DateTimeFormat;
    let dtfConstructs = 0;
    const constructedTzs: string[] = [];
    const SpyDTF = function (
      this: unknown,
      locales?: Intl.LocalesArgument,
      options?: Intl.DateTimeFormatOptions,
    ) {
      dtfConstructs += 1;
      constructedTzs.push(options?.timeZone ?? "(local)");
      return new RealDTF(locales, options);
    } as unknown as typeof Intl.DateTimeFormat;
    SpyDTF.supportedLocalesOf = RealDTF.supportedLocalesOf;
    vi.stubGlobal("Intl", { ...Intl, DateTimeFormat: SpyDTF });

    const body = document.createElement("div");
    const { ctx, emitSettings } = makeCtx({
      cities: [
        { name: "London", tz: "Europe/London" },
        { name: "Tokyo", tz: "Asia/Tokyo" },
        { name: "Bad", tz: "Invalid/Zone" },
      ],
    });
    const inst = worldClockWidget.mount(body, ctx) as {
      refresh?: () => void;
      destroy?: () => void;
    };

    const listEl = body.querySelector<HTMLElement>("[data-list]")!;
    // 2 formatters per valid tz + 1 failed attempt for Invalid/Zone at mount
    expect(dtfConstructs).toBe(5);
    const badTimeEl = listEl.children[2].querySelector<HTMLElement>(".w-mono")!;
    expect(badTimeEl.textContent).toBe("–");
    expect(badTimeEl.style.color).toBe("var(--bad)");

    // Attach MutationObserver after initial mount tick
    const observer = new MutationObserver(() => {});
    observer.observe(listEl, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });

    // 30 ticks within the same minute -> 0 Intl.DateTimeFormat constructions & 0 DOM mutations
    dtfConstructs = 0;
    for (let s = 0; s < 30; s++) {
      vi.setSystemTime(new Date(Date.now() + 1000));
      inst.refresh?.();
    }
    expect(dtfConstructs).toBe(0);
    expect(observer.takeRecords()).toHaveLength(0);

    // Arbitrary redundant refresh at exact same instant -> 0 DOM mutations
    inst.refresh?.();
    expect(observer.takeRecords()).toHaveLength(0);

    // Crossing into next minute (12:01) updates time text only (not day span or style)
    vi.setSystemTime(new Date("2026-11-16T12:01:00.000Z"));
    inst.refresh?.();
    const minuteMutations = observer.takeRecords();
    expect(minuteMutations.length).toBeGreaterThan(0);
    expect(minuteMutations.every((m) => m.type === "childList" && m.target !== listEl)).toBe(true);

    // Update list: keep London, evict Tokyo & Bad, add New York
    dtfConstructs = 0;
    constructedTzs.length = 0;
    emitSettings({
      cities: [
        { name: "London", tz: "Europe/London" },
        { name: "New York", tz: "America/New_York" },
      ],
    });
    // London stayed cached; only New York constructed formatters
    expect(constructedTzs).toEqual(["America/New_York", "America/New_York"]);

    // Re-adding evicted Tokyo constructs its formatters fresh (proving eviction happened)
    constructedTzs.length = 0;
    emitSettings({
      cities: [
        { name: "London", tz: "Europe/London" },
        { name: "New York", tz: "America/New_York" },
        { name: "Tokyo", tz: "Asia/Tokyo" },
      ],
    });
    expect(constructedTzs).toEqual(["Asia/Tokyo", "Asia/Tokyo"]);

    // Adding a duplicate timezone city via the UI reuses cached formatters (0 new constructions)
    constructedTzs.length = 0;
    const addBtn = body.querySelector<HTMLButtonElement>("[data-add]")!;
    const nameIn = body.querySelector<HTMLInputElement>("[data-name]")!;
    const tzIn = body.querySelector<HTMLInputElement>("[data-tz]")!;
    const saveBtn = body.querySelector<HTMLButtonElement>("[data-save]")!;
    addBtn.click();
    nameIn.value = "Osaka";
    tzIn.value = "Asia/Tokyo";
    saveBtn.click();
    expect(constructedTzs).toEqual([]);
    expect(listEl.children.length).toBe(4);

    // Adding an invalid timezone via UI shows error without polluting cache
    nameIn.value = "Mars";
    tzIn.value = "Mars/Olympus";
    saveBtn.click();
    expect(body.querySelector<HTMLElement>("[data-err]")!.textContent).toBe("Unknown time zone");

    observer.disconnect();
    inst.destroy?.();
  });

  it("matches reference output across same day, DST transitions, and local midnight rollover", () => {
    vi.useFakeTimers();

    const cities = [
      { name: "New York", tz: "America/New_York" },
      { name: "London", tz: "Europe/London" },
      { name: "Tokyo", tz: "Asia/Tokyo" },
      { name: "Kiritimati", tz: "Pacific/Kiritimati" },
    ];

    const body = document.createElement("div");
    const { ctx } = makeCtx({ cities });

    // Local midnight boundary check based on current local Date
    const d1 = new Date(2026, 10, 16, 23, 59, 0, 0);
    vi.setSystemTime(d1);
    const inst = worldClockWidget.mount(body, ctx) as {
      refresh?: () => void;
      destroy?: () => void;
    };

    const readRows = () =>
      Array.from(body.querySelectorAll<HTMLElement>("[data-list] > .w-row")).map((row) => {
        const spans = row.querySelectorAll<HTMLElement>("span");
        return {
          name: spans[0].textContent,
          day: spans[1].textContent,
          time: spans[2].textContent,
        };
      });

    const checkInstant = (instant: Date) => {
      vi.setSystemTime(instant);
      inst.refresh?.();
      const rendered = readRows();
      for (let i = 0; i < cities.length; i++) {
        const expected = refCityTime(cities[i].tz, instant);
        expect(rendered[i].time).toBe(expected.time);
        expect(rendered[i].day).toBe(expected.day);
      }
    };

    // 1. Same local day before midnight -> across local midnight (23:59 -> 00:01)
    checkInstant(d1);
    const beforeDays = readRows().map((r) => r.day);
    const d2 = new Date(2026, 10, 17, 0, 1, 0, 0);
    checkInstant(d2);
    const afterDays = readRows().map((r) => r.day);
    expect(afterDays).not.toEqual(beforeDays);

    // 2. US DST spring forward (2026-03-08 01:59 EST -> 03:00 EDT)
    checkInstant(new Date("2026-03-08T06:59:00.000Z"));
    checkInstant(new Date("2026-03-08T07:00:00.000Z"));
    expect(readRows()[0].time).toBe("03:00");

    // 3. US DST fall back (2026-11-01 01:30 EDT -> 01:30 EST)
    checkInstant(new Date("2026-11-01T05:30:00.000Z"));
    checkInstant(new Date("2026-11-01T06:30:00.000Z"));
    expect(readRows()[0].time).toBe("01:30");

    // 4. EU DST transition (2026-03-29 00:59 GMT -> 02:00 BST)
    checkInstant(new Date("2026-03-29T00:59:00.000Z"));
    checkInstant(new Date("2026-03-29T01:00:00.000Z"));
    expect(readRows()[1].time).toBe("02:00");

    inst.destroy?.();
  });
});
