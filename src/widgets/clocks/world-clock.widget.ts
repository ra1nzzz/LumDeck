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
  const out: City[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (out.length >= MAX_CITIES) break;
      if (!item || typeof item !== "object") continue;
      const o = item as { name?: unknown; tz?: unknown };
      const name = typeof o.name === "string" ? o.name.trim() : "";
      const tz = typeof o.tz === "string" ? o.tz.trim() : "";
      if (name && tz) out.push({ name, tz });
    }
  }
  return out.length ? out : clone(DEFAULTS);
}

function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23" });
    return true;
  } catch {
    return false;
  }
}

/** Local wall-clock time + day offset for a time zone. Never throws. */
function cityTime(tz: string, now: Date): { time: string; day: string; ok: boolean } {
  const fallback = { time: "–", day: "", ok: false };
  try {
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(now);
    const local = Date.parse(new Intl.DateTimeFormat("en-CA").format(now));
    const remote = Date.parse(new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now));
    const diff = Math.round((remote - local) / DAY_MS);
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
      time: HTMLElement;
      day: HTMLElement;
    }
    let rows: Row[] = [];

    const tick = () => {
      const now = new Date();
      for (const r of rows) {
        const t = cityTime(r.tz, now);
        r.time.textContent = t.time;
        r.day.textContent = t.day;
        r.time.style.color = t.ok ? "" : "var(--bad)";
      }
    };

    const persist = () => {
      ctx.setSettings({ cities: clone(cities) });
    };

    const renderRows = () => {
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
        return { tz: c.tz, time, day };
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
      if (!validTz(tz)) {
        showError("Unknown time zone");
        return;
      }
      if (cities.length >= MAX_CITIES) {
        showError(`Up to ${MAX_CITIES} cities`);
        return;
      }
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
      },
    };
  },
};

export default mod;
