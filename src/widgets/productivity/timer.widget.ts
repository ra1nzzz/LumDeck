import type { WidgetModule } from "../../core/types";
import { icons } from "../icons";

const ico = (svg: string, px = 12) =>
  `<span class="w-icon" style="width:${px}px;height:${px}px">${svg}</span>`;

const mmss = (ms: number) => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

const mod: WidgetModule = {
  id: "timer",
  name: "Timer",
  group: "productivity",
  description: "A simple countdown",
  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12M7 3v3.5M17 3v3.5"/><path d="M6.5 6.5h11l-1.2 12.6a2 2 0 0 1-2 1.9H9.7a2 2 0 0 1-2-1.9z"/><path d="M9.5 11.5h5"/></svg>`,
  defaultSize: { w: 2, h: 1 },
  mount(body, ctx) {
    let minutes = Math.min(180, Math.max(1, Math.round(Number(ctx.settings.minutes)) || 5));
    let totalMs = minutes * 60000;
    let remaining = totalMs;
    let running = false;
    let done = false;
    let endAt = 0;
    let timer: number | undefined;

    body.innerHTML = `
      <div class="w-row w-title" style="justify-content:space-between">
        <span>Timer</span>
        <span data-status class="w-faint" style="font-size:10px"></span>
      </div>
      <div class="w-big w-mono" data-time style="margin-top:1px">--:--</div>
      <div style="height:4px;border-radius:2px;background:var(--track);overflow:hidden;margin:4px 0 5px">
        <div data-bar style="height:100%;width:100%;background:var(--accent)"></div>
      </div>
      <div class="w-row" style="gap:5px">
        <button data-toggle class="w-btn" style="flex:1"></button>
        <button data-reset class="w-btn">Reset</button>
        <label class="w-title w-row" style="gap:3px">min<input data-min type="number" min="1" max="180" value="${minutes}"
          style="width:34px;padding:2px 3px;font-size:10px;text-align:center;border-radius:6px;border:1px solid var(--glass-border);background:var(--tile-bg);color:var(--text)"></label>
      </div>`;

    const styleEl = document.createElement("style");
    styleEl.textContent =
      "@keyframes lum-timer-pulse{0%,100%{opacity:1}50%{opacity:.5}}.lum-timer-done{animation:lum-timer-pulse 1.8s ease-in-out infinite;color:var(--good)}";
    body.appendChild(styleEl);

    const timeEl = body.querySelector<HTMLElement>("[data-time]")!;
    const statusEl = body.querySelector<HTMLElement>("[data-status]")!;
    const barEl = body.querySelector<HTMLElement>("[data-bar]")!;
    const toggleBtn = body.querySelector<HTMLButtonElement>("[data-toggle]")!;
    const resetBtn = body.querySelector<HTMLButtonElement>("[data-reset]")!;
    const minInput = body.querySelector<HTMLInputElement>("[data-min]")!;

    const stopTimer = () => {
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
      endAt = 0;
    };

    const render = () => {
      timeEl.textContent = mmss(remaining);
      const pct = totalMs > 0 ? Math.max(0, Math.min(1, remaining / totalMs)) : 0;
      barEl.style.width = `${(pct * 100).toFixed(1)}%`;
      barEl.style.background = done ? "var(--good)" : "var(--accent)";
      timeEl.classList.toggle("lum-timer-done", done);
      statusEl.textContent = done ? "time's up" : running ? "running" : "ready";
      toggleBtn.innerHTML = running
        ? `${ico(icons.pause)}Pause`
        : `${ico(icons.play)}${done ? "Again" : "Start"}`;
    };

    // Settle elapsed time against the active deadline before ticking or pausing so
    // early pauses and late event-loop wakes preserve exact remaining time and finish once.
    const settle = (now = Date.now()) => {
      if (!running) return;
      remaining = endAt - now;
      if (remaining <= 0) {
        remaining = 0;
        running = false;
        done = true;
        stopTimer();
      }
    };

    const tick = () => {
      settle();
      render();
    };

    const toggle = () => {
      const now = Date.now();
      if (running) {
        settle(now);
        if (running) {
          running = false;
          stopTimer();
        }
      } else {
        if (done || remaining <= 0) {
          remaining = totalMs;
          done = false;
        }
        running = true;
        endAt = now + remaining;
        if (timer !== undefined) window.clearInterval(timer);
        timer = window.setInterval(tick, 200);
      }
      render();
    };

    const reset = () => {
      running = false;
      done = false;
      stopTimer();
      remaining = totalMs;
      render();
    };

    const applyMinutes = () => {
      minutes = Math.min(180, Math.max(1, Math.round(Number(minInput.value)) || 5));
      minInput.value = String(minutes);
      totalMs = minutes * 60000;
      ctx.setSettings({ minutes });
      if (!running) {
        done = false;
        remaining = totalMs;
      }
      render();
    };

    toggleBtn.addEventListener("click", toggle);
    resetBtn.addEventListener("click", reset);
    minInput.addEventListener("change", applyMinutes);

    render();
    return {
      destroy() {
        running = false;
        stopTimer();
        styleEl.remove();
      },
    };
  },
};

export default mod;
