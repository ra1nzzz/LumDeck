import type { WidgetModule } from "../../core/types";
import { icons } from "../icons";

interface SystemStats {
  battery: number | null;
  charging: boolean;
  on_ac: boolean;
  has_battery: boolean;
}

const mod: WidgetModule = {
  id: "battery",
  name: "Battery",
  group: "system",
  description: "Battery level and charging state",
  icon: icons.battery,
  defaultSize: { w: 2, h: 1 },
  refreshMs: 5000,
  async mount(body, ctx) {
    body.innerHTML = `
      <div class="w-row" style="justify-content:space-between;gap:8px;height:100%">
        <div class="w-col" style="flex:1;min-width:0">
          <div class="w-big w-mono" data-pct>–</div>
          <div data-bar style="height:6px;border-radius:3px;background:var(--track);margin-top:6px;overflow:hidden">
            <div data-fill style="height:100%;width:0%;border-radius:3px;background:var(--accent)"></div>
          </div>
          <div class="w-title" style="margin-top:4px" data-label>&nbsp;</div>
        </div>
        <div class="w-icon" data-bolt style="width:20px;height:20px;color:var(--warn);display:none">${icons.bolt}</div>
      </div>`;

    const pct = body.querySelector<HTMLElement>("[data-pct]")!;
    const bar = body.querySelector<HTMLElement>("[data-bar]")!;
    const fill = body.querySelector<HTMLElement>("[data-fill]")!;
    const label = body.querySelector<HTMLElement>("[data-label]")!;
    const bolt = body.querySelector<HTMLElement>("[data-bolt]")!;

    const color = (v: number) => (v <= 20 ? "var(--bad)" : v <= 40 ? "var(--warn)" : "var(--good)");

    const refresh = async () => {
      try {
        const s = await ctx.invoke<SystemStats>("system_stats");
        if (s.has_battery && s.battery != null) {
          const v = Math.max(0, Math.min(100, Math.round(s.battery)));
          pct.textContent = `${v}%`;
          fill.style.width = `${v}%`;
          fill.style.background = color(v);
          bar.style.display = "";
          label.textContent = s.charging ? "charging" : s.on_ac ? "on AC" : "on battery";
          bolt.style.display = s.charging ? "inline-flex" : "none";
        } else {
          pct.textContent = "AC";
          bar.style.display = "none";
          label.textContent = "· no battery";
          bolt.style.display = "none";
        }
      } catch {
        pct.textContent = "–";
        bar.style.display = "none";
        label.textContent = "unavailable";
        bolt.style.display = "none";
      }
    };

    await refresh();
    return { refresh };
  },
};

export default mod;
