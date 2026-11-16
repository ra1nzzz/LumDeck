import type { WidgetModule } from "../../core/types";
import { icons } from "../icons";

const FLIP_MS = 460;
const SWAP_MS = 230;

// Sizes are expressed in cqw (1cqw = 1% of the tile body width) so the clock
// scales with the dock size setting, capped by a px value so wide tiles keep a
// sane size. The plain px value is declared first as a fallback for engines
// without container query units.
const cardStyle = (small: boolean): string =>
  `background:var(--tile-bg);border:1px solid var(--tile-border);` +
  `border-radius:${small ? "3px" : "8px"};border-radius:${small ? "min(2.4cqw,3px)" : "min(6cqw,8px)"};` +
  `padding:${small ? "0 3px" : "1px 3px"};padding:${small ? "min(0.4cqw,0.8px) min(2.2cqw,3px)" : "min(0.8cqw,1.5px) min(2.4cqw,3.5px)"};` +
  `font-size:${small ? 10 : 19.8}px;font-size:${small ? "min(7.2cqw,12px)" : "min(15cqw,23px)"};` +
  `font-weight:700;line-height:1.2;font-variant-numeric:tabular-nums;text-align:center;` +
  `min-width:${small ? 12 : 20}px;min-width:${small ? "min(9cqw,13px)" : "min(15cqw,20px)"};` +
  `will-change:transform,opacity`;

const cell = (key: string, small: boolean): string =>
  `<div style="perspective:280px"><div data-c="${key}" style="${cardStyle(small)}">0</div></div>`;

const mod: WidgetModule = {
  id: "clock-flip",
  name: "Flip Clock",
  group: "clocks",
  description: "Hours and minutes that flip on the second",
  icon: icons.clock,
  defaultSize: { w: 2, h: 1 },
  refreshMs: 1000,
  mount(body) {
    body.innerHTML = `
      <div class="w-col" style="height:100%;align-items:center;justify-content:center;gap:3px;container-type:inline-size">
        <div class="w-row" style="align-items:center;gap:3px;gap:min(2.2cqw,3px)">
          ${cell("h0", false)}${cell("h1", false)}
          <span class="w-dim w-mono" style="font-size:16.5px;font-size:min(12.5cqw,19px);font-weight:700">:</span>
          ${cell("m0", false)}${cell("m1", false)}
          <div class="w-col" style="gap:2px;gap:min(1.5cqw,2px);margin-left:2px;margin-left:min(1.6cqw,2px)">
            ${cell("s0", true)}${cell("s1", true)}
          </div>
        </div>
        <div class="w-title w-dim" data-date style="text-align:center">&nbsp;</div>
      </div>`;

    const keys = ["h0", "h1", "m0", "m1", "s0", "s1"] as const;
    const cards = new Map<string, HTMLElement>();
    for (const k of keys) {
      const el = body.querySelector<HTMLElement>(`[data-c="${k}"]`);
      if (el) cards.set(k, el);
    }
    const date = body.querySelector<HTMLElement>("[data-date]")!;

    const pending = new Set<number>();
    let primed = false;

    const flip = (key: string, value: string) => {
      const el = cards.get(key);
      if (!el) return;
      if (el.textContent === value) return;
      if (!primed) {
        el.textContent = value;
        return;
      }
      const id = window.setTimeout(() => {
        pending.delete(id);
        el.textContent = value;
      }, SWAP_MS);
      pending.add(id);
      if (typeof el.animate === "function") {
        el.animate(
          [
            { transform: "rotateX(0deg)", opacity: 1 },
            { transform: "rotateX(-86deg)", opacity: 0.15, offset: 0.5 },
            { transform: "rotateX(86deg)", opacity: 0.15, offset: 0.52 },
            { transform: "rotateX(0deg)", opacity: 1 },
          ],
          { duration: FLIP_MS, easing: "cubic-bezier(.4,0,.6,1)" },
        );
      } else {
        el.textContent = value;
      }
    };

    const tick = () => {
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, "0");
      const mm = String(now.getMinutes()).padStart(2, "0");
      const ss = String(now.getSeconds()).padStart(2, "0");
      flip("h0", hh.slice(0, 1));
      flip("h1", hh.slice(1));
      flip("m0", mm.slice(0, 1));
      flip("m1", mm.slice(1));
      flip("s0", ss.slice(0, 1));
      flip("s1", ss.slice(1));
      date.textContent = now.toLocaleDateString([], {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
      primed = true;
    };

    tick();
    return {
      refresh: tick,
      destroy: () => {
        for (const id of pending) window.clearTimeout(id);
        pending.clear();
      },
    };
  },
};

export default mod;
