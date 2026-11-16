import type { WidgetModule } from "../../core/types";
import { icons } from "../icons";

interface NetSpeed {
  down_bps: number;
  up_bps: number;
}

const fmtBps = (bps: number): string => {
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(1)} Gb/s`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mb/s`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(0)} Kb/s`;
  return `${Math.round(bps)} b/s`;
};

const mod: WidgetModule = {
  id: "network",
  name: "Network",
  group: "system",
  description: "Connection status and throughput",
  icon: icons.wifi,
  defaultSize: { w: 2, h: 1 },
  refreshMs: 2000,
  async mount(body, ctx) {
    body.innerHTML = `
      <div class="w-row" style="gap:9px;height:100%">
        <div data-dot style="width:9px;height:9px;border-radius:50%;background:var(--text-faint);flex:0 0 auto"></div>
        <div class="w-col" style="gap:2px;min-width:0">
          <div class="w-value" data-status>…</div>
          <div class="w-row w-mono" style="gap:10px;font-size:11px;display:none" data-speed>
            <span class="w-dim">↓ <b data-down>–</b></span>
            <span class="w-dim">↑ <b data-up>–</b></span>
          </div>
        </div>
      </div>`;

    const dot = body.querySelector<HTMLElement>("[data-dot]")!;
    const status = body.querySelector<HTMLElement>("[data-status]")!;
    const speed = body.querySelector<HTMLElement>("[data-speed]")!;
    const down = body.querySelector<HTMLElement>("[data-down]")!;
    const up = body.querySelector<HTMLElement>("[data-up]")!;

    const refresh = async () => {
      let online = false;
      try {
        online = await ctx.invoke<boolean>("net_connected");
      } catch {
        online = navigator.onLine;
      }
      dot.style.background = online ? "var(--good)" : "var(--bad)";
      status.textContent = online ? "Online" : "Offline";
      status.className = online ? "w-value w-good" : "w-value w-bad";
      try {
        const s = await ctx.invoke<NetSpeed>("net_speed");
        speed.style.display = "flex";
        down.textContent = fmtBps(Math.max(0, s.down_bps));
        up.textContent = fmtBps(Math.max(0, s.up_bps));
      } catch {
        speed.style.display = "none";
      }
    };

    await refresh();
    return { refresh };
  },
};

export default mod;
