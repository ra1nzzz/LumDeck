import type { WidgetModule } from "../../core/types";
import { icons } from "../icons";

interface City {
  name: string;
  tz: string;
}

const DEFAULTS: City[] = [
  { name: "London", tz: "Europe/London" },
  { name: "Tokyo", tz: "Asia/Tokyo" },
  { name: "New York", tz: "America/New_York" },
];

const MAX_CITIES = 4;
const DAY_MS = 86400000;

function clone(cities: City[]): City[] {
  return cities.map((c) => ({ ...c }));
}

function loadCities(raw: unknown): City[] {
  // Preserve an explicit saved array (including []) and only seed defaults when unset/invalid.
  if (!Array.isArray(raw)) return clone(DEFAULTS);
  const out: City[] = [];
  for (const item of raw) {
    if (out.length >= MAX_CITIES) break;
    if (!item || typeof item !== "object") continue;
    const o = item as { name?: unknown; tz?: unknown };
    const name = typeof o.name === "string" ? o.name.trim() : "";
    const tz = typeof o.tz === "string" ? o.tz.trim() : "";
    if (name && tz) out.push({ name, tz });
  }
  return out;
}

interface TzFormatters {
  time: Intl.DateTimeFormat;
  date: Intl.DateTimeFormat;
}

function createTzFormatters(tz: string): TzFormatters | null {
  try {
    return {
      time: new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }),
      date: new Intl.DateTimeFormat("en-CA", { timeZone: tz }),
    };
  } catch {
    return null;
  }
}

/** Local wall-clock time + day offset using cached formatters and precomputed local day. Never throws. */
function cityTime(
  fmts: TzFormatters | null,
  now: Date,
  localDay: number,
): { time: string; day: string; ok: boolean } {
  const fallback = { time: "–", day: "", ok: false };
  if (!fmts) return fallback;
  try {
    const time = fmts.time.format(now);
    const remote = Date.parse(fmts.date.format(now));
    if (!Number.isFinite(remote)) return fallback;
    const diff = Math.round((remote - localDay) / DAY_MS);
    const day = diff === 0 ? "" : diff > 0 ? `+${diff}d` : `${diff}d`;
    return { time, day, ok: true };
  } catch {
    return fallback;
  }
}

const mod: WidgetModule = {
  id: "clock-world",
  name: "World Clock",
  group: "clocks",
  description: "Local time in up to four cities",
  icon: icons.globe,
  defaultSize: { w: 2, h: 1 },
  refreshMs: 1000,
  mount(body, ctx) {
    let cities = loadCities(ctx.settings.cities);

    body.innerHTML = `
      <style>[data-wc-list]{scrollbar-width:none}[data-wc-list]::-webkit-scrollbar{display:none}</style>
      <div class="w-col" style="height:100%;gap:2px;container-type:inline-size">
        <div class="w-row" style="gap:5px">
          <span class="w-title">World Clock</span>
          <div class="w-spacer"></div>
          <button class="w-btn" data-add style="padding:1px 5px;padding:1px min(3.8cqw,5px);font-size:10px;font-size:min(7.6cqw,10px);line-height:1.2" title="Add a city">+</button>
        </div>
        <div class="w-col" data-list data-wc-list style="gap:1px;flex:1;min-height:0;overflow:auto"></div>
        <div class="w-col" data-form style="gap:4px;display:none">
          <input class="search" data-name style="margin:0;padding:4px 7px;font-size:11px" placeholder="City name" />
          <div class="w-row" style="gap:5px">
            <input class="search" data-tz style="margin:0;padding:4px 7px;font-size:11px;flex:1;min-width:0" placeholder="Time zone (e.g. Europe/Paris)" />
            <button class="w-btn" data-save style="padding:4px 8px">Add</button>
          </div>
          <div class="w-error" data-err>&nbsp;</div>
        </div>
      </div>`;

    const list = body.querySelector<HTMLElement>("[data-list]")!;
    const form = body.querySelector<HTMLElement>("[data-form]")!;
    const addBtn = body.querySelector<HTMLButtonElement>("[data-add]")!;
    const nameIn = body.querySelector<HTMLInputElement>("[data-name]")!;
    const tzIn = body.querySelector<HTMLInputElement>("[data-tz]")!;
    const saveBtn = body.querySelector<HTMLButtonElement>("[data-save]")!;
    const err = body.querySelector<HTMLElement>("[data-err]")!;

    interface Row {
      tz: string;
      fmts: TzFormatters | null;
      time: HTMLElement;
      day: HTMLElement;
      lastTime: string;
      lastDay: string;
      lastOk: boolean;
    }
    let rows: Row[] = [];
    const tzCache = new Map<string, TzFormatters>();

    const getFormatters = (tz: string): TzFormatters | null => {
      const cached = tzCache.get(tz);
      if (cached) return cached;
      const created = createTzFormatters(tz);
      if (created) tzCache.set(tz, created);
      return created;
    };

    const tick = () => {
      const now = new Date();
      const localDay = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
      for (const r of rows) {
        const t = cityTime(r.fmts, now, localDay);
        if (t.time !== r.lastTime) {
          r.time.textContent = t.time;
          r.lastTime = t.time;
        }
        if (t.day !== r.lastDay) {
          r.day.textContent = t.day;
          r.lastDay = t.day;
        }
        if (t.ok !== r.lastOk) {
          r.time.style.color = t.ok ? "" : "var(--bad)";
          r.lastOk = t.ok;
        }
      }
    };

    const persist = () => {
      ctx.setSettings({ cities: clone(cities) });
    };

    const renderRows = () => {
      const activeTzs = new Set(cities.map((c) => c.tz));
      for (const tz of tzCache.keys()) {
        if (!activeTzs.has(tz)) tzCache.delete(tz);
      }

      list.innerHTML = "";
      rows = cities.map((c) => {
        const row = document.createElement("div");
        row.className = "w-row";
        row.style.cssText =
          "gap:5px;font-size:10.5px;font-size:min(8cqw,11px);line-height:1.3;align-items:center";

        const name = document.createElement("span");
        name.className = "w-dim";
        name.style.cssText =
          "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
        name.textContent = c.name;

        const day = document.createElement("span");
        day.className = "w-faint";
        day.style.cssText = "font-size:9px";

        const time = document.createElement("span");
        time.className = "w-mono";
        time.style.cssText = "font-weight:650";
        time.textContent = "--:--";

        const del = document.createElement("button");
        del.className = "w-btn";
        del.style.cssText =
          "padding:0 4px;padding:0 min(3cqw,4px);font-size:11px;font-size:min(8cqw,11px);line-height:1;background:transparent;color:var(--text-faint)";
        del.textContent = "×";
        del.title = `Remove ${c.name}`;
        del.addEventListener("click", () => {
          cities = cities.filter((x) => x !== c);
          persist();
          renderRows();
        });

        row.append(name, day, time, del);
        list.appendChild(row);
        return {
          tz: c.tz,
          fmts: getFormatters(c.tz),
          time,
          day,
          lastTime: "--:--",
          lastDay: "",
          lastOk: true,
        };
      });
      addBtn.disabled = cities.length >= MAX_CITIES;
      tick();
    };

    const showError = (msg: string) => {
      err.textContent = msg || "\u00a0";
    };

    const openForm = (open: boolean) => {
      form.style.display = open ? "flex" : "none";
      addBtn.textContent = open ? "×" : "+";
      addBtn.title = open ? "Cancel" : "Add a city";
      if (open) nameIn.focus();
      else showError("");
    };

    const save = () => {
      const name = nameIn.value.trim();
      const tz = tzIn.value.trim();
      if (!name) {
        showError("Enter a city name");
        return;
      }
      if (!tz) {
        showError("Enter a time zone, e.g. Europe/Paris");
        return;
      }
      const fmts = tzCache.get(tz) ?? createTzFormatters(tz);
      if (!fmts) {
        showError("Unknown time zone");
        return;
      }
      if (cities.length >= MAX_CITIES) {
        showError(`Up to ${MAX_CITIES} cities`);
        return;
      }
      tzCache.set(tz, fmts);
      cities = [...cities, { name, tz }];
      persist();
      renderRows();
      nameIn.value = "";
      tzIn.value = "";
      showError("");
      openForm(false);
    };

    addBtn.addEventListener("click", () => {
      openForm(form.style.display === "none");
    });
    saveBtn.addEventListener("click", save);
    nameIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter") save();
    });
    tzIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter") save();
    });

    renderRows();

    const unsub = ctx.onSettings((s) => {
      const next = loadCities(s.cities);
      const same =
        next.length === cities.length &&
        next.every((c, i) => c.name === cities[i].name && c.tz === cities[i].tz);
      if (!same) {
        cities = next;
        renderRows();
      }
    });

    return {
      refresh: tick,
      destroy: () => {
        unsub();
        tzCache.clear();
        rows = [];
      },
    };
  },
};

export default mod;
