import { classifyIpcUnavailable, type IpcUnavailableReason } from "../../core/tauri";
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
          <input class="w-slider" type="range" min="0" max="100" step="1" value="50" data-slider disabled />
          <div class="w-row" style="justify-content:space-between">
            <span class="w-title">Brightness</span>
            <span class="w-title w-mono" data-val>–</span>
          </div>
        </div>
      </div>`;

    const slider = body.querySelector<HTMLInputElement>("[data-slider]")!;
    const val = body.querySelector<HTMLElement>("[data-val]")!;
    let timer = 0;
    let destroyed = false;
    let unavailableReason: IpcUnavailableReason | null = null;

    const unavailable = (reason: IpcUnavailableReason) => {
      if (destroyed || unavailableReason !== null) return;
      unavailableReason = reason;
      window.clearTimeout(timer);
      slider.disabled = true;
      const label =
        reason === "preview"
          ? "Brightness · browser preview"
          : "Brightness · not available in this build";
      body.innerHTML = `
        <div class="w-row" style="gap:8px;height:100%">
          <div class="w-icon w-faint" style="width:18px;height:18px">${icons.sun}</div>
          <span class="w-dim" style="font-size:12px">${label}</span>
        </div>`;
    };

    slider.addEventListener("input", () => {
      if (destroyed || unavailableReason !== null) return;
      val.textContent = `${slider.value}%`;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (destroyed || unavailableReason !== null) return;
        void ctx.invoke("brightness_set", { level: Number(slider.value) }).catch((e) => {
          if (destroyed) return;
          const reason = classifyIpcUnavailable(e, ["brightness_set", "brightness_get"]);
          if (reason) unavailable(reason);
        });
      }, 120);
    });

    void (async () => {
      try {
        const level = await ctx.invoke<number>("brightness_get");
        if (destroyed || unavailableReason !== null) return;
        const v = Math.max(0, Math.min(100, Math.round(level)));
        slider.disabled = false;
        slider.value = String(v);
        val.textContent = `${v}%`;
      } catch (e) {
        if (destroyed) return;
        unavailable(classifyIpcUnavailable(e, ["brightness_get", "brightness_set"]) ?? "native");
      }
    })();

    return {
      destroy: () => {
        destroyed = true;
        window.clearTimeout(timer);
      },
    };
  },
};

export default mod;
