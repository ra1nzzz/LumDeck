import type { WidgetModule, SettingsBag } from "../../core/types";
import { icons } from "../icons";

interface Location {
  lat: number;
  lon: number;
  label: string;
}

interface DailyResponse {
  daily?: {
    time?: string[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    weather_code?: number[];
  };
}

const DEFAULT_LOC: Location = { lat: 51.5074, lon: -0.1278, label: "London" };

const svg = (inner: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

const GLYPH = {
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
  cloudSun: svg('<circle cx="8.5" cy="7.5" r="3"/><path d="M8.5 1.8v1.4M2.8 7.5h1.4M4.2 3.2l1 1M12.8 3.2l-1 1"/><path d="M17.5 20a4.5 4.5 0 0 0 .4-8.98A6 6 0 0 0 6.6 9.6 4.5 4.5 0 0 0 7.5 20z"/>'),
  cloud: svg('<path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.1 9.5 4.5 4.5 0 0 0 7 19z"/>'),
  fog: svg('<path d="M17.5 18a4 4 0 0 0 .4-7.98A5.5 5.5 0 0 0 6.4 8.8 4 4 0 0 0 7 18z"/><path d="M4 21h16M6 23h12" transform="translate(0,-1)"/>'),
  rain: svg('<path d="M17.5 15a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.1 5.5 4.5 4.5 0 0 0 7 15z"/><path d="M8 18v2.5M12 18v2.5M16 18v2.5"/>'),
  snow: svg('<path d="M17.5 15a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.1 5.5 4.5 4.5 0 0 0 7 15z"/><path d="M8 19.5v1.5M6.7 20.2l2.6 1.6M9.3 20.2l-2.6 1.6M12 19.5v1.5M16 19.5v1.5M14.7 20.2l2.6 1.6M17.3 20.2l-2.6 1.6"/>'),
  thunder: svg('<path d="M17.5 15a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.1 5.5 4.5 4.5 0 0 0 7 15z"/><path d="M13 12l-3.5 5h3l-1.5 5 5-6.5h-3z"/>'),
};

function readLocation(settings: SettingsBag): Location {
  const raw = settings.location;
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const lat = Number(o.lat);
    const lon = Number(o.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      const label = typeof o.label === "string" && o.label.trim() ? o.label.trim() : DEFAULT_LOC.label;
      return { lat, lon, label };
    }
  }
  return DEFAULT_LOC;
}

/** WMO weather code -> glyph + short label. */
function describe(code: number, isDay: boolean): { icon: string; label: string } {
  switch (code) {
    case 0:
      return isDay ? { icon: GLYPH.sun, label: "Clear" } : { icon: GLYPH.moon, label: "Clear" };
    case 1:
      return isDay ? { icon: GLYPH.sun, label: "Mainly clear" } : { icon: GLYPH.moon, label: "Mainly clear" };
    case 2:
      return { icon: GLYPH.cloudSun, label: "Partly cloudy" };
    case 3:
      return { icon: GLYPH.cloud, label: "Overcast" };
    case 45:
      return { icon: GLYPH.fog, label: "Fog" };
    case 48:
      return { icon: GLYPH.fog, label: "Rime fog" };
    case 51:
    case 53:
      return { icon: GLYPH.rain, label: "Drizzle" };
    case 55:
      return { icon: GLYPH.rain, label: "Dense drizzle" };
    case 56:
    case 57:
      return { icon: GLYPH.rain, label: "Freezing drizzle" };
    case 61:
      return { icon: GLYPH.rain, label: "Light rain" };
    case 63:
      return { icon: GLYPH.rain, label: "Rain" };
    case 65:
      return { icon: GLYPH.rain, label: "Heavy rain" };
    case 66:
    case 67:
      return { icon: GLYPH.rain, label: "Freezing rain" };
    case 71:
    case 73:
    case 77:
      return { icon: GLYPH.snow, label: "Snow" };
    case 75:
      return { icon: GLYPH.snow, label: "Heavy snow" };
    case 80:
    case 81:
      return { icon: GLYPH.rain, label: "Showers" };
    case 82:
      return { icon: GLYPH.rain, label: "Heavy showers" };
    case 85:
    case 86:
      return { icon: GLYPH.snow, label: "Snow showers" };
    case 95:
      return { icon: GLYPH.thunder, label: "Thunderstorm" };
    case 96:
    case 99:
      return { icon: GLYPH.thunder, label: "Thunder + hail" };
    default:
      return { icon: GLYPH.cloud, label: "Unknown" };
  }
}

const fmtTemp = (v: number | undefined): string =>
  typeof v === "number" && Number.isFinite(v) ? String(Math.round(v)) : "–";

const weekday = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString([], { weekday: "short" });
};

/** fetch with a timeout; an externally supplied signal is honoured too. */
async function fetchTimeout(url: string, opts: RequestInit = {}, ms = 10000): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  const outer = opts.signal;
  const onAbort = () => ac.abort();
  if (outer) {
    if (outer.aborted) ac.abort();
    else outer.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
    outer?.removeEventListener("abort", onAbort);
  }
}

const mod: WidgetModule = {
  id: "weather-forecast",
  name: "Forecast",
  group: "weather",
  description: "5-day outlook from Open-Meteo",
  icon: icons.calendar,
  defaultSize: { w: 3, h: 1 },
  refreshMs: 1800000,
  async mount(body, ctx) {
    let loc = readLocation(ctx.settings);
    let alive = true;
    let ac: AbortController | null = null;

    body.innerHTML = `
      <div class="w-col" style="gap:3px;height:100%;justify-content:center">
        <div class="w-row" style="justify-content:space-between;gap:6px">
          <span class="w-title" data-loc>&nbsp;</span>
          <button class="w-btn" data-edit style="padding:1px 5px" title="Change location">${icons.sliders}</button>
        </div>
        <div class="w-row" data-view style="flex:1;gap:4px"></div>
        <div data-editor class="w-col" style="display:none;gap:3px">
          <div class="w-row" style="gap:4px">
            <input data-lat class="search" style="margin:0;padding:2px 5px;font-size:10px;flex:1.3;min-width:0" placeholder="lat" />
            <input data-lon class="search" style="margin:0;padding:2px 5px;font-size:10px;flex:1.3;min-width:0" placeholder="lon" />
            <input data-label class="search" style="margin:0;padding:2px 5px;font-size:10px;flex:1;min-width:0" placeholder="city" />
            <button data-save class="w-btn" style="padding:2px 7px">Save</button>
          </div>
          <div class="w-error" data-err></div>
        </div>
      </div>`;

    const view = body.querySelector<HTMLElement>("[data-view]")!;
    const locLabel = body.querySelector<HTMLElement>("[data-loc]")!;
    const editor = body.querySelector<HTMLElement>("[data-editor]")!;
    const editBtn = body.querySelector<HTMLButtonElement>("[data-edit]")!;
    const latI = body.querySelector<HTMLInputElement>("[data-lat]")!;
    const lonI = body.querySelector<HTMLInputElement>("[data-lon]")!;
    const labelI = body.querySelector<HTMLInputElement>("[data-label]")!;
    const saveBtn = body.querySelector<HTMLButtonElement>("[data-save]")!;
    const err = body.querySelector<HTMLElement>("[data-err]")!;

    const syncEditor = () => {
      latI.value = String(loc.lat);
      lonI.value = String(loc.lon);
      labelI.value = loc.label;
    };
    syncEditor();

    const setEditing = (on: boolean) => {
      editor.style.display = on ? "flex" : "none";
      view.style.display = on ? "none" : "flex";
      locLabel.style.visibility = on ? "hidden" : "visible";
      if (on) {
        err.textContent = "";
        syncEditor();
        latI.focus();
      }
    };
    editBtn.addEventListener("click", () => setEditing(editor.style.display === "none"));

    const save = () => {
      const lat = Number(latI.value.trim());
      const lon = Number(lonI.value.trim());
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        err.textContent = "lat −90..90, lon −180..180";
        return;
      }
      const label = labelI.value.trim() || DEFAULT_LOC.label;
      ctx.setSettings({ location: { lat, lon, label } });
      setEditing(false);
    };
    saveBtn.addEventListener("click", save);
    for (const input of [latI, lonI, labelI]) {
      input.addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key === "Enter") save();
      });
    }

    const unsub = ctx.onSettings((s) => {
      const next = readLocation(s);
      if (next.lat !== loc.lat || next.lon !== loc.lon || next.label !== loc.label) {
        loc = next;
        syncEditor();
        void refresh();
      }
    });

    const refresh = async (): Promise<void> => {
      ac?.abort();
      const ctrl = new AbortController();
      ac = ctrl;
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
        `&daily=temperature_2m_max,temperature_2m_min,weather_code&forecast_days=7&timezone=auto`;
      try {
        const res = await fetchTimeout(url, { signal: ctrl.signal }, 12000);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as DailyResponse;
        if (!alive || ctrl.signal.aborted) return;
        const d = data.daily;
        const times = d?.time;
        if (!d || !Array.isArray(times) || times.length === 0) throw new Error("no daily block");

        view.innerHTML = "";
        const n = Math.min(5, times.length);
        for (let i = 0; i < n; i++) {
          const cond = describe(Number(d.weather_code?.[i] ?? -1), true);
          const col = document.createElement("div");
          col.className = "w-col";
          col.style.cssText = "align-items:center;gap:1px;flex:1;min-width:0";

          const day = document.createElement("div");
          day.className = "w-title";
          day.textContent = i === 0 ? "Today" : weekday(String(times[i]));

          const ic = document.createElement("div");
          ic.className = "w-icon w-accent";
          ic.style.cssText = "width:16px;height:16px";
          ic.innerHTML = cond.icon;

          const temps = document.createElement("div");
          temps.className = "w-mono";
          temps.style.cssText = "font-size:10px;white-space:nowrap";
          temps.innerHTML =
            `${fmtTemp(d.temperature_2m_max?.[i])}° <span class="w-faint">${fmtTemp(d.temperature_2m_min?.[i])}°</span>`;

          col.append(day, ic, temps);
          view.appendChild(col);
        }
        locLabel.textContent = loc.label;
      } catch {
        if (!alive || ctrl.signal.aborted) return;
        view.innerHTML = "";
        const msg = document.createElement("span");
        msg.className = "w-dim";
        msg.style.cssText = "font-size:11px";
        msg.textContent = "No connection";
        view.appendChild(msg);
      }
    };

    await refresh();
    return {
      refresh,
      destroy: () => {
        alive = false;
        ac?.abort();
        ac = null;
        unsub();
      },
    };
  },
};

export default mod;
