import type { WidgetModule } from "../../core/types";
import { icons } from "../icons";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const DOW = [
  { s: "S", n: "Sunday" },
  { s: "M", n: "Monday" },
  { s: "T", n: "Tuesday" },
  { s: "W", n: "Wednesday" },
  { s: "T", n: "Thursday" },
  { s: "F", n: "Friday" },
  { s: "S", n: "Saturday" },
];

const mod: WidgetModule = {
  id: "calendar",
  name: "Calendar",
  group: "productivity",
  description: "A compact month view",
  icon: icons.calendar,
  defaultSize: { w: 2, h: 2 },
  refreshMs: 60000,
  mount(body) {
    const now = new Date();
    let viewY = now.getFullYear();
    let viewM = now.getMonth();

    body.innerHTML = `
      <div class="w-row" style="justify-content:space-between;margin-bottom:3px">
        <button data-prev class="w-btn" style="padding:1px 7px" title="Previous month">&#8249;</button>
        <span data-label class="w-title" title="Jump to today"
          style="font-size:11px;font-weight:600;color:var(--text);cursor:pointer"></span>
        <button data-next class="w-btn" style="padding:1px 7px" title="Next month">&#8250;</button>
      </div>
      <div data-grid style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;flex:1"></div>`;

    const label = body.querySelector<HTMLElement>("[data-label]")!;
    const grid = body.querySelector<HTMLElement>("[data-grid]")!;
    const prevBtn = body.querySelector<HTMLButtonElement>("[data-prev]")!;
    const nextBtn = body.querySelector<HTMLButtonElement>("[data-next]")!;

    const addCell = (text: string, style: string) => {
      const c = document.createElement("div");
      c.textContent = text;
      c.style.cssText = style;
      grid.appendChild(c);
      return c;
    };

    const render = () => {
      const today = new Date();
      label.textContent = `${MONTHS[viewM]} ${viewY}`;
      grid.innerHTML = "";

      DOW.forEach((d) => {
        const h = document.createElement("div");
        h.className = "w-faint";
        h.title = d.n;
        h.style.cssText = "text-align:center;font-size:9px;line-height:1.6";
        h.textContent = d.s;
        grid.appendChild(h);
      });

      const startDow = new Date(viewY, viewM, 1).getDay();
      const daysInMonth = new Date(viewY, viewM + 1, 0).getDate();
      const prevMonthDays = new Date(viewY, viewM, 0).getDate();
      const cells = Math.ceil((startDow + daysInMonth) / 7) * 7;

      for (let i = 0; i < cells; i++) {
        const dayNum = i - startDow + 1;
        const base =
          "display:flex;align-items:center;justify-content:center;font-size:10px;line-height:1;border-radius:50%;aspect-ratio:1;";
        if (dayNum < 1) {
          addCell(String(prevMonthDays + dayNum), base + "color:var(--text-faint);opacity:.45");
        } else if (dayNum > daysInMonth) {
          addCell(String(dayNum - daysInMonth), base + "color:var(--text-faint);opacity:.45");
        } else {
          const isToday =
            today.getFullYear() === viewY &&
            today.getMonth() === viewM &&
            today.getDate() === dayNum;
          const weekend = new Date(viewY, viewM, dayNum).getDay() % 6 === 0;
          if (isToday) {
            addCell(
              String(dayNum),
              base + "background:var(--accent);color:#fff;font-weight:700",
            );
          } else {
            addCell(
              String(dayNum),
              base + (weekend ? "color:var(--text-faint)" : "color:var(--text-dim)"),
            );
          }
        }
      }
    };

    const shift = (delta: number) => {
      const d = new Date(viewY, viewM + delta, 1);
      viewY = d.getFullYear();
      viewM = d.getMonth();
      render();
    };

    const jumpToday = () => {
      const t = new Date();
      viewY = t.getFullYear();
      viewM = t.getMonth();
      render();
    };

    prevBtn.addEventListener("click", () => shift(-1));
    nextBtn.addEventListener("click", () => shift(1));
    label.addEventListener("click", jumpToday);

    render();
    return { refresh: render };
  },
};

export default mod;
