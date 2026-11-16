import type { WidgetModule } from "../../core/types";
import { icons } from "../icons";

const mod: WidgetModule = {
  id: "clock-digital",
  name: "Digital Clock",
  group: "clocks",
  description: "Time, weekday and date",
  icon: icons.clock,
  defaultSize: { w: 2, h: 1 },
  mount(body) {
    body.innerHTML = `
      <div class="w-row" style="justify-content:space-between;height:100%">
        <div class="w-col">
          <div class="w-big w-mono" data-t>--:--</div>
          <div class="w-dim" style="font-size:11px" data-d>&nbsp;</div>
        </div>
        <div class="w-icon w-accent" style="width:22px;height:22px">${icons.clock}</div>
      </div>`;
    const t = body.querySelector<HTMLElement>("[data-t]")!;
    const d = body.querySelector<HTMLElement>("[data-d]")!;
    const tick = () => {
      const now = new Date();
      t.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      d.textContent = now.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return { destroy: () => clearInterval(id) };
  },
};

export default mod;
