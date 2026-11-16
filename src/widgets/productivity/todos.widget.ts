import type { WidgetModule } from "../../core/types";
import { icons } from "../icons";

interface Todo {
  text: string;
  done: boolean;
}

const mod: WidgetModule = {
  id: "todo-list",
  name: "Todos",
  group: "productivity",
  description: "A quick checklist",
  icon: icons.check,
  defaultSize: { w: 2, h: 2 },
  mount(body, ctx) {
    let items: Todo[] = Array.isArray(ctx.settings.items) ? (ctx.settings.items as Todo[]) : [];

    body.innerHTML = `
      <div class="w-row w-title" style="justify-content:space-between">
        <span>Todos</span><span data-count class="w-faint"></span>
      </div>
      <div data-list class="w-col" style="gap:4px;overflow:auto;flex:1"></div>
      <div class="w-row" style="gap:6px;margin-top:4px">
        <input data-input class="search" style="margin:0;padding:5px 8px;font-size:12px" placeholder="Add a task…" />
        <button data-add class="w-btn" style="padding:5px 9px">${icons.plus}</button>
      </div>`;

    const list = body.querySelector<HTMLElement>("[data-list]")!;
    const count = body.querySelector<HTMLElement>("[data-count]")!;
    const input = body.querySelector<HTMLInputElement>("[data-input]")!;
    const addBtn = body.querySelector<HTMLButtonElement>("[data-add]")!;

    const persist = () => ctx.setSettings({ items });

    const render = () => {
      list.innerHTML = "";
      const open = items.filter((t) => !t.done).length;
      count.textContent = items.length ? `${open} open` : "";
      items.forEach((t, i) => {
        const row = document.createElement("div");
        row.className = "w-row";
        row.style.cssText = "gap:7px;font-size:12px;align-items:center";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = t.done;
        cb.style.accentColor = "var(--accent)";
        cb.addEventListener("change", () => {
          items[i].done = cb.checked;
          persist();
          render();
        });
        const label = document.createElement("span");
        label.textContent = t.text;
        label.style.cssText = t.done ? "text-decoration:line-through;color:var(--text-faint);flex:1" : "flex:1";
        const del = document.createElement("button");
        del.className = "w-btn";
        del.style.cssText = "padding:0 5px;background:transparent;color:var(--text-faint)";
        del.textContent = "×";
        del.addEventListener("click", () => {
          items.splice(i, 1);
          persist();
          render();
        });
        row.append(cb, label, del);
        list.appendChild(row);
      });
    };

    const add = () => {
      const text = input.value.trim();
      if (!text) return;
      items.push({ text, done: false });
      input.value = "";
      persist();
      render();
    };
    addBtn.addEventListener("click", add);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") add();
    });

    render();
    return {};
  },
};

export default mod;
