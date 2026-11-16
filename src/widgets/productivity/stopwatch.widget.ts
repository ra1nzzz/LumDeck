import type { WidgetModule } from "../../core/types";
import { icons } from "../icons";

const ico = (svg: string, px = 12) =>
  `<span class="w-icon" style="width:${px}px;height:${px}px">${svg}</span>`;

const fmt = (ms: number) => {
  const t = Math.max(0, ms);
  const m = Math.floor(t / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const cs = Math.floor((t % 1000) / 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
};

const mod: WidgetModule = {
  id: "stopwatch",
  name: "Stopwatch",
  group: "productivity",
  description: "Start, pause and lap",
  icon: icons.clock,
  defaultSize: { w: 2, h: 1 },
  mount(body) {
    let base = 0; // ms accumulated before the current run
    let startedAt = 0; // performance.now() at the last start
    let running = false;
    let timer: number | undefined;
    let laps: number[] = []; // in-memory only

    body.innerHTML = `
      <div class="w-row" style="justify-content:space-between">
        <span class="w-title">Stopwatch</span>
        <span data-status class="w-faint" style="font-size:10px"></span>
      </div>
      <div class="w-big w-mono" data-time style="margin-top:1px">00:00.00</div>
      <div data-laps class="w-col" style="gap:2px;overflow:auto;flex:1;margin-top:3px"></div>
      <div class="w-row" style="gap:5px;margin-top:4px">
        <button data-toggle class="w-btn" style="flex:1"></button>
        <button data-lap class="w-btn">Lap</button>
        <button data-reset class="w-btn">Reset</button>
      </div>`;

    const timeEl = body.querySelector<HTMLElement>("[data-time]")!;
    const statusEl = body.querySelector<HTMLElement>("[data-status]")!;
    const lapsEl = body.querySelector<HTMLElement>("[data-laps]")!;
    const toggleBtn = body.querySelector<HTMLButtonElement>("[data-toggle]")!;
    const lapBtn = body.querySelector<HTMLButtonElement>("[data-lap]")!;
    const resetBtn = body.querySelector<HTMLButtonElement>("[data-reset]")!;

    const elapsed = () => base + (running ? performance.now() - startedAt : 0);

    const stopTimer = () => {
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    };

    const renderTime = () => {
      timeEl.textContent = fmt(elapsed());
    };

    const renderLaps = () => {
      lapsEl.innerHTML = "";
      if (!laps.length) {
        const empty = document.createElement("span");
        empty.className = "w-faint";
        empty.style.fontSize = "10px";
        empty.textContent = "No laps yet";
        lapsEl.appendChild(empty);
        return;
      }
      for (let i = laps.length - 1; i >= 0; i--) {
        const split = laps[i] - (i > 0 ? laps[i - 1] : 0);
        const row = document.createElement("div");
        row.className = "w-row";
        row.style.cssText = "justify-content:space-between;font-size:10px";
        const n = document.createElement("span");
        n.className = "w-faint";
        n.textContent = `#${i + 1}`;
        const sp = document.createElement("span");
        sp.className = "w-mono w-dim";
        sp.textContent = `+${fmt(split)}`;
        const tot = document.createElement("span");
        tot.className = "w-mono";
        tot.textContent = fmt(laps[i]);
        row.append(n, sp, tot);
        lapsEl.appendChild(row);
      }
    };

    const renderButtons = () => {
      toggleBtn.innerHTML = running ? `${ico(icons.pause)}Pause` : `${ico(icons.play)}Start`;
      statusEl.textContent = running ? "running" : base > 0 ? "paused" : "";
      lapBtn.disabled = !running;
      lapBtn.style.opacity = running ? "1" : "0.45";
    };

    const toggle = () => {
      if (running) {
        base = elapsed();
        running = false;
        stopTimer();
      } else {
        startedAt = performance.now();
        running = true;
        timer = window.setInterval(renderTime, 50);
      }
      renderTime();
      renderButtons();
    };

    const lap = () => {
      if (!running) return;
      laps.push(elapsed());
      renderLaps();
    };

    const reset = () => {
      running = false;
      stopTimer();
      base = 0;
      laps = [];
      renderTime();
      renderLaps();
      renderButtons();
    };

    toggleBtn.addEventListener("click", toggle);
    lapBtn.addEventListener("click", lap);
    resetBtn.addEventListener("click", reset);

    renderTime();
    renderLaps();
    renderButtons();
    return { destroy: stopTimer };
  },
};

export default mod;
