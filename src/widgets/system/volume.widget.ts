import { classifyIpcUnavailable, type IpcUnavailableReason } from "../../core/tauri";
import type { WidgetModule } from "../../core/types";
import { icons } from "../icons";

interface VolumeState {
  level: number;
  muted: boolean;
  device: string;
}

const volumeGlyph = `<span class="w-icon" style="width:14px;height:14px">${icons.volume}</span>`;
const mutedGlyph = `<span class="w-icon" style="width:14px;height:14px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M16 9l6 6M22 9l-6 6"/></svg></span>`;

const mod: WidgetModule = {
  id: "volume",
  name: "Volume",
  group: "system",
  description: "Output volume and mute",
  icon: icons.volume,
  defaultSize: { w: 2, h: 1 },
  refreshMs: 3000,
  async mount(body, ctx) {
    body.innerHTML = `
      <div class="w-row" style="gap:8px;height:100%">
        <button class="w-btn" data-mute style="padding:5px 7px;flex:0 0 auto" title="Mute / unmute">${volumeGlyph}</button>
        <div class="w-col" style="flex:1;min-width:0;gap:5px">
          <input class="w-slider" type="range" min="0" max="100" step="1" value="50" data-slider />
          <div class="w-row" style="justify-content:space-between">
            <span class="w-title" data-device style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">&nbsp;</span>
            <span class="w-title w-mono" data-val>–</span>
          </div>
        </div>
      </div>`;

    const muteBtn = body.querySelector<HTMLButtonElement>("[data-mute]")!;
    const slider = body.querySelector<HTMLInputElement>("[data-slider]")!;
    const val = body.querySelector<HTMLElement>("[data-val]")!;
    const device = body.querySelector<HTMLElement>("[data-device]")!;
    let destroyed = false;
    let unavailableReason: IpcUnavailableReason | null = null;

    const apply = (v: VolumeState) => {
      if (destroyed || unavailableReason !== null) return;
      const pct = Math.max(0, Math.min(100, Math.round(v.level * 100)));
      if (document.activeElement !== slider) slider.value = String(pct);
      val.textContent = v.muted ? "muted" : `${pct}%`;
      val.className = v.muted ? "w-title w-mono w-warn" : "w-title w-mono";
      device.textContent = v.device || "\u00a0";
      muteBtn.innerHTML = v.muted ? mutedGlyph : volumeGlyph;
    };

    const unavailable = (reason: IpcUnavailableReason) => {
      if (destroyed || unavailableReason !== null) return;
      unavailableReason = reason;
      muteBtn.disabled = true;
      slider.disabled = true;
      const label =
        reason === "preview"
          ? "Volume · browser preview"
          : "Volume · not available in this build";
      body.innerHTML = `
        <div class="w-row" style="gap:8px;height:100%">
          <div class="w-icon w-faint" style="width:18px;height:18px">${icons.volume}</div>
          <span class="w-dim" style="font-size:12px">${label}</span>
        </div>`;
    };

    const refresh = async () => {
      if (destroyed || unavailableReason !== null) return;
      try {
        apply(await ctx.invoke<VolumeState>("volume_get"));
      } catch (e) {
        if (destroyed) return;
        unavailable(classifyIpcUnavailable(e, ["volume_get", "volume_set", "volume_toggle_mute"]) ?? "native");
      }
    };

    slider.addEventListener("input", () => {
      if (destroyed || unavailableReason !== null) return;
      val.textContent = `${slider.value}%`;
      void ctx.invoke("volume_set", { level: Number(slider.value) / 100 }).catch((e) => {
        if (destroyed) return;
        const reason = classifyIpcUnavailable(e, ["volume_set", "volume_get"]);
        if (reason) {
          unavailable(reason);
        } else {
          val.textContent = "–";
        }
      });
    });

    muteBtn.addEventListener("click", () => {
      if (destroyed || unavailableReason !== null) return;
      void (async () => {
        try {
          await ctx.invoke("volume_toggle_mute");
          await refresh();
        } catch (e) {
          if (destroyed) return;
          unavailable(classifyIpcUnavailable(e, ["volume_toggle_mute", "volume_get"]) ?? "native");
        }
      })().catch(() => {});
    });

    await refresh();
    return {
      refresh,
      destroy: () => {
        destroyed = true;
      },
    };
  },
};

export default mod;
