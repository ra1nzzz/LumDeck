import type { WidgetModule } from "../../core/types";
import { icons } from "../icons";

const ico = (svg: string, px = 12) =>
  `<span class="w-icon" style="width:${px}px;height:${px}px">${svg}</span>`;

const dayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const mmss = (ms: number) => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

const mod: WidgetModule = {
  id: "pomodoro",
  name: "Pomodoro",
  group: "productivity",
  description: "Focus/break cycles with a daily counter",
  icon: icons.timer,
  defaultSize: { w: 2, h: 1 },
  mount(body, ctx) {
    let workMin = Math.min(90, Math.max(1, Math.round(Number(ctx.settings.workMin)) || 25));
    let breakMin = Math.min(30, Math.max(1, Math.round(Number(ctx.settings.breakMin)) || 5));
    let countDate = typeof ctx.settings.date === "string" ? ctx.settings.date : "";
    let count =
      countDate === dayKey() ? Math.max(0, Math.round(Number(ctx.settings.count)) || 0) : 0;

    let mode: "work" | "break" = "work";
    let phaseMs = workMin * 60000;
    let remaining = phaseMs;
    let running = false;
    let endAt = 0;
    let timer: number | undefined;

    body.innerHTML = `
      <div class="w-row w-title" style="justify-content:space-between">
        <span data-mode>Focus</span>
        <span data-count class="w-faint"></span>
      </div>
      <div class="w-big w-mono" data-time style="margin-top:1px">--:--</div>
      <div style="height:4px;border-radius:2px;background:var(--track);overflow:hidden;margin:4px 0 5px">
        <div data-bar style="height:100%;width:0%;background:var(--accent)"></div>
      </div>
      <div class="w-row" style="gap:5px">
        <button data-toggle class="w-btn" style="flex:1"></button>
        <button data-reset class="w-btn">Reset</button>
        <label class="w-title w-row" style="gap:2px">W<input data-work type="number" min="1" max="90" value="${workMin}"
          style="width:30px;padding:2px 3px;font-size:10px;text-align:center;border-radius:6px;border:1px solid var(--glass-border);background:var(--tile-bg);color:var(--text)"></label>
        <label class="w-title w-row" style="gap:2px">B<input data-brk type="number" min="1" max="30" value="${breakMin}"
          style="width:30px;padding:2px 3px;font-size:10px;text-align:center;border-radius:6px;border:1px solid var(--glass-border);background:var(--tile-bg);color:var(--text)"></label>
      </div>`;

    const modeEl = body.querySelector<HTMLElement>("[data-mode]")!;
    const countEl = body.querySelector<HTMLElement>("[data-count]")!;
    const timeEl = body.querySelector<HTMLElement>("[data-time]")!;
    const barEl = body.querySelector<HTMLElement>("[data-bar]")!;
    const toggleBtn = body.querySelector<HTMLButtonElement>("[data-toggle]")!;
    const resetBtn = body.querySelector<HTMLButtonElement>("[data-reset]")!;
    const workInput = body.querySelector<HTMLInputElement>("[data-work]")!;
    const brkInput = body.querySelector<HTMLInputElement>("[data-brk]")!;

    const stopTimer = () => {
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    };

    const render = () => {
      timeEl.textContent = mmss(remaining);
      const pct = phaseMs > 0 ? Math.max(0, Math.min(1, remaining / phaseMs)) : 0;
      barEl.style.width = `${(pct * 100).toFixed(1)}%`;
      barEl.style.background = mode === "work" ? "var(--accent)" : "var(--good)";
      modeEl.textContent = mode === "work" ? "Focus" : "Break";
      countEl.textContent = `${count} today`;
      toggleBtn.innerHTML = running ? `${ico(icons.pause)}Pause` : `${ico(icons.play)}Start`;
    };

    const tick = () => {
      const key = dayKey();
      if (key !== countDate) {
        countDate = key;
        count = 0;
      }
      if (running) {
        remaining = endAt - Date.now();
        if (remaining <= 0) {
          if (mode === "work") {
            count += 1;
            ctx.setSettings({ count, date: key });
          }
          mode = mode === "work" ? "break" : "work";
          phaseMs = (mode === "work" ? workMin : breakMin) * 60000;
          remaining = phaseMs;
          endAt = Date.now() + remaining;
        }
      }
      render();
    };

    const toggle = () => {
      if (running) {
        running = false;
        stopTimer();
      } else {
        if (remaining <= 0) remaining = phaseMs;
        running = true;
        endAt = Date.now() + remaining;
        timer = window.setInterval(tick, 250);
      }
      render();
    };

    const reset = () => {
      running = false;
      stopTimer();
      mode = "work";
      phaseMs = workMin * 60000;
      remaining = phaseMs;
      render();
    };

    const applyDurations = () => {
      workMin = Math.min(90, Math.max(1, Math.round(Number(workInput.value)) || 25));
      breakMin = Math.min(30, Math.max(1, Math.round(Number(brkInput.value)) || 5));
      workInput.value = String(workMin);
      brkInput.value = String(breakMin);
      ctx.setSettings({ workMin, breakMin });
      if (!running) {
        phaseMs = (mode === "work" ? workMin : breakMin) * 60000;
        remaining = phaseMs;
      }
      render();
    };

    toggleBtn.addEventListener("click", toggle);
    resetBtn.addEventListener("click", reset);
    workInput.addEventListener("change", applyDurations);
    brkInput.addEventListener("change", applyDurations);

    render();
    return { destroy: stopTimer };
  },
};

export default mod;
