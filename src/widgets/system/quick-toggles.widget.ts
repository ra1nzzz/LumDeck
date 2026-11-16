import type { WidgetModule } from "../../core/types";
import { icons } from "../icons";

interface Toggle {
  label: string;
  title: string;
  uri: string;
  icon: string;
}

const bluetooth = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7l10 10-5 5V2l5 5L7 17"/></svg>`;
const airplane = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15.5v-2l-8-4.5V3.5a1.5 1.5 0 0 0-3 0V9l-8 4.5v2l8-2.5V15l-2.5 1.5v2l4.5-1 4.5 1v-2L14 15v-3z"/></svg>`;
const dnd = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12h8"/></svg>`;

const TOGGLES: Toggle[] = [
  { label: "Wi-Fi", title: "Wi-Fi", uri: "ms-settings:network", icon: icons.wifi },
  { label: "BT", title: "Bluetooth", uri: "ms-settings:bluetooth", icon: bluetooth },
  { label: "Air", title: "Airplane mode", uri: "ms-settings:network-airplanemode", icon: airplane },
  { label: "DND", title: "Do Not Disturb", uri: "ms-settings:notifications", icon: dnd },
  { label: "Night", title: "Night light", uri: "ms-settings:nightlight", icon: icons.sun },
  { label: "Saver", title: "Battery saver", uri: "ms-settings:batterysaver", icon: icons.battery },
];

const mod: WidgetModule = {
  id: "quick-toggles",
  name: "Quick Toggles",
  group: "system",
  description: "Jump to Windows settings toggles",
  icon: icons.sliders,
  defaultSize: { w: 3, h: 1 },
  mount(body, ctx) {
    body.innerHTML = `
      <div class="w-row" style="gap:5px;height:100%;justify-content:space-between">
        ${TOGGLES.map(
          (t) => `
          <button class="w-btn" data-uri="${t.uri}" title="${t.title}"
            style="flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;gap:2px;padding:5px 2px">
            <span class="w-icon" style="width:15px;height:15px">${t.icon}</span>
            <span style="font-size:9px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.label}</span>
          </button>`,
        ).join("")}
      </div>`;

    const flashes: number[] = [];
    body.querySelectorAll<HTMLButtonElement>("[data-uri]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const uri = btn.dataset.uri;
        if (!uri) return;
        btn.style.color = "var(--accent)";
        flashes.push(
          window.setTimeout(() => {
            btn.style.color = "";
          }, 250),
        );
        void ctx.invoke("open_path", { path: uri }).catch(() => {});
      });
    });

    return {
      destroy: () => flashes.forEach((id) => window.clearTimeout(id)),
    };
  },
};

export default mod;
