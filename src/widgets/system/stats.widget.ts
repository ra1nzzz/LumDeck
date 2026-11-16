import type { WidgetModule } from "../../core/types";
import { icons } from "../icons";

interface Stats {
  cpu: number;
  ram: number;
  ram_used_gb: number;
  ram_total_gb: number;
  battery: number | null;
  charging: boolean;
  on_ac: boolean;
  has_battery: boolean;
}

function gauge(label: string): string {
  const c = 2 * Math.PI * 15;
  return `
    <div class="w-col" style="align-items:center;gap:3px">
      <div class="w-gauge">
        <svg width="40" height="40">
          <circle cx="20" cy="20" r="15" fill="none" stroke="var(--track)" stroke-width="4"/>
          <circle class="ring" cx="20" cy="20" r="15" fill="none" stroke="var(--accent)" stroke-width="4"
            stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${c.toFixed(1)}"/>
        </svg>
        <div class="g-val w-mono">–</div>
      </div>
      <div class="w-title">${label}</div>
    </div>`;
}

const mod: WidgetModule = {
  id: "system-stats",
  name: "System Stats",
  group: "system",
  description: "Live CPU and memory",
  icon: icons.cpu,
  defaultSize: { w: 3, h: 1 },
  refreshMs: 2000,
  async mount(body, ctx) {
    body.innerHTML = `<div class="w-row" style="gap:16px;height:100%">${gauge("CPU")}${gauge("RAM")}</div>`;
    const rings = body.querySelectorAll<SVGCircleElement>(".ring");
    const vals = body.querySelectorAll<HTMLElement>(".g-val");
    const C = 2 * Math.PI * 15;

    const setGauge = (i: number, pct: number, text: string) => {
      rings[i].style.strokeDashoffset = (C * (1 - pct / 100)).toFixed(1);
      vals[i].textContent = text;
    };

    const refresh = async () => {
      try {
        const s = await ctx.invoke<Stats>("system_stats");
        setGauge(0, Math.round(s.cpu), `${Math.round(s.cpu)}%`);
        setGauge(1, Math.round(s.ram), `${Math.round(s.ram)}%`);
      } catch {
        setGauge(0, 0, "–");
        setGauge(1, 0, "–");
      }
    };
    await refresh();
    return { refresh };
  },
};

export default mod;
