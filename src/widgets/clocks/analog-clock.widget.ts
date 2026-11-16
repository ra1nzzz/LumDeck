import type { WidgetModule } from "../../core/types";
import { icons } from "../icons";

/** 60 tick marks; every fifth one is an hour mark. */
function tickMarks(): string {
  let out = "";
  for (let i = 0; i < 60; i++) {
    const a = ((i * 6 - 90) * Math.PI) / 180;
    const major = i % 5 === 0;
    const r1 = major ? 36 : 41;
    const r2 = 44.5;
    const x1 = (50 + r1 * Math.cos(a)).toFixed(2);
    const y1 = (50 + r1 * Math.sin(a)).toFixed(2);
    const x2 = (50 + r2 * Math.cos(a)).toFixed(2);
    const y2 = (50 + r2 * Math.sin(a)).toFixed(2);
    out += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"` +
      ` style="stroke:${major ? "var(--text-dim)" : "var(--text-faint)"};` +
      `stroke-width:${major ? 2 : 1};stroke-linecap:round"/>`;
  }
  return out;
}

const mod: WidgetModule = {
  id: "clock-analog",
  name: "Analog Clock",
  group: "clocks",
  description: "Classic sweep of hour, minute and second hands",
  icon: icons.clock,
  defaultSize: { w: 2, h: 2 },
  mount(body) {
    body.innerHTML = `
      <div class="w-col" style="height:100%;gap:3px">
        <div style="flex:1;min-height:0;min-width:0;display:flex;align-items:center;justify-content:center">
          <svg viewBox="0 0 100 100" style="width:100%;height:100%;display:block">
            <circle cx="50" cy="50" r="47" style="fill:var(--tile-bg);stroke:var(--tile-border);stroke-width:1"/>
            <g data-ticks>${tickMarks()}</g>
            <g data-hh><line x1="50" y1="56" x2="50" y2="27"
              style="stroke:var(--text);stroke-width:3.4;stroke-linecap:round"/></g>
            <g data-mm><line x1="50" y1="56" x2="50" y2="16"
              style="stroke:var(--text);stroke-width:2.2;stroke-linecap:round"/></g>
            <g data-ss><line x1="50" y1="60" x2="50" y2="13"
              style="stroke:var(--accent);stroke-width:1.2;stroke-linecap:round"/></g>
            <circle cx="50" cy="50" r="2.6" style="fill:var(--accent)"/>
          </svg>
        </div>
        <div class="w-title w-dim" data-date style="text-align:center">&nbsp;</div>
      </div>`;

    const hh = body.querySelector<SVGGElement>("[data-hh]")!;
    const mm = body.querySelector<SVGGElement>("[data-mm]")!;
    const ss = body.querySelector<SVGGElement>("[data-ss]")!;
    const date = body.querySelector<HTMLElement>("[data-date]")!;

    const rotate = (el: SVGGElement, deg: number) => {
      el.setAttribute("transform", `rotate(${deg.toFixed(2)} 50 50)`);
    };

    const tick = () => {
      const now = new Date();
      const s = now.getSeconds() + now.getMilliseconds() / 1000;
      const m = now.getMinutes() + s / 60;
      const h = (now.getHours() % 12) + m / 60;
      rotate(ss, s * 6);
      rotate(mm, m * 6);
      rotate(hh, h * 30);
      date.textContent = now.toLocaleDateString([], {
        weekday: "long",
        month: "short",
        day: "numeric",
      });
    };

    // Align ticks to the wall-clock second boundary so hands never drift.
    let timer = 0;
    const schedule = () => {
      const delay = 1000 - (Date.now() % 1000);
      timer = window.setTimeout(() => {
        try {
          tick();
        } finally {
          schedule();
        }
      }, delay);
    };

    tick();
    schedule();

    return {
      refresh: tick,
      destroy: () => {
        if (timer) window.clearTimeout(timer);
      },
    };
  },
};

export default mod;
