import type { WidgetModule } from "../../core/types";
import { icons } from "../icons";

const mod: WidgetModule = {
  id: "brightness",
  name: "Brightness",
  group: "system",
  description: "Screen brightness",
  icon: icons.sun,
  defaultSize: { w: 2, h: 1 },
  mount(body, ctx) {
    body.innerHTML = `
      <div class="w-row" style="gap:9px;height:100%">
        <div class="w-icon w-warn" style="width:18px;height:18px">${icons.sun}</div>
        <div class="w-col" style="flex:1;min-width:0;gap:5px">
          <input class="w-slider" type="range" min="0" max="100" step="1" value="50" data-slider />
          <div class="w-row" style="justify-content:space-between">
            <span class="w-title">Brightness</span>
            <span class="w-title w-mono" data-val>–</span>
          </div>
        </div>
      </div>`;

    const slider = body.querySelector<HTMLInputElement>("[data-slider]")!;
    const val = body.querySelector<HTMLElement>("[data-val]")!;
    let timer = 0;

    const unavailable = () => {
      window.clearTimeout(timer);
      body.innerHTML = `
        <div class="w-row" style="gap:8px;height:100%">
          <div class="w-icon w-faint" style="width:18px;height:18px">${icons.sun}</div>
          <span class="w-dim" style="font-size:12px">Brightness not available</span>
        </div>`;
    };

    slider.addEventListener("input", () => {
      val.textContent = `${slider.value}%`;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void ctx.invoke("brightness_set", { level: Number(slider.value) }).catch(() => {});
      }, 120);
    });

    void (async () => {
      try {
        const level = await ctx.invoke<number>("brightness_get");
        const v = Math.max(0, Math.min(100, Math.round(level)));
        slider.value = String(v);
        val.textContent = `${v}%`;
      } catch {
        unavailable();
      }
    })();

    return { destroy: () => window.clearTimeout(timer) };
  },
};

export default mod;
