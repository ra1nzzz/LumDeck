import type { WidgetModule } from "../../core/types";
import { icons } from "../icons";

interface AppEntry {
  name: string;
  target: string;
}

const DEFAULTS: AppEntry[] = [
  { name: "Settings", target: "ms-settings:" },
  { name: "Files", target: "explorer" },
  { name: "Notepad", target: "notepad" },
  { name: "Calc", target: "calc" },
  { name: "Browser", target: "https://" },
];

const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);

const cloneDefaults = (): AppEntry[] => DEFAULTS.map((a) => ({ ...a }));

const parseApps = (raw: unknown): AppEntry[] => {
  if (!Array.isArray(raw)) return cloneDefaults();
  const out: AppEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const name = String(rec.name ?? "").trim();
    const target = String(rec.target ?? "").trim();
    if (name && target) out.push({ name, target });
  }
  return out;
};

const glyphFor = (name: string, target: string): string => {
  if (/^https?:\/\//i.test(target)) return icons.globe;
  if (target.includes("/") || target.includes("\\")) return icons.folder;
  const first = name.trim()[0];
  return first ? esc(first.toUpperCase()) : "?";
};

const STYLE = `
  .al-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(46px, 1fr)); gap: 6px; }
  .al-app {
    position: relative; display: flex; flex-direction: column; align-items: center; gap: 3px;
    padding: 6px 2px 5px; border: none; border-radius: 10px; overflow: hidden;
    background: var(--tile-bg); color: var(--text); cursor: pointer; font: inherit;
  }
  .al-app:hover { background: var(--accent); color: #fff; }
  .al-glyph {
    width: 26px; height: 26px; border-radius: 8px; display: grid; place-items: center;
    background: var(--tile-bg-hover); font-size: 13px; font-weight: 700;
  }
  .al-app:hover .al-glyph { background: rgba(255, 255, 255, 0.22); }
  .al-glyph svg { width: 15px; height: 15px; }
  .al-lbl { font-size: 9px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .al-x {
    position: absolute; top: 1px; right: 1px; width: 13px; height: 13px; padding: 0;
    border: none; border-radius: 50%; background: var(--bad); color: #fff;
    font-size: 9px; line-height: 1; display: none; align-items: center; justify-content: center; cursor: pointer;
  }
  .al-grid.editing .al-x { display: flex; }
`;

const mod: WidgetModule = {
  id: "app-launcher",
  name: "App Launcher",
  group: "apps",
  description: "A configurable grid of shortcuts",
  icon: icons.grid,
  defaultSize: { w: 2, h: 2 },
  mount(body, ctx) {
    const style = document.createElement("style");
    style.textContent = STYLE;

    let apps: AppEntry[] = parseApps(ctx.settings.apps);
    let editing = false;

    body.innerHTML = `
      <div class="w-col" style="height:100%;gap:6px">
        <div class="w-row w-title" style="justify-content:space-between">
          <span class="w-row" style="gap:5px">
            <span class="w-icon w-accent" style="width:13px;height:13px">${icons.grid}</span>
            <span>App Launcher</span>
          </span>
          <span class="w-row" style="gap:5px">
            <span data-count class="w-faint"></span>
            <button data-edit class="w-btn" style="padding:2px 7px">Edit</button>
          </span>
        </div>
        <div data-grid class="al-grid" style="flex:1;overflow:auto;align-content:flex-start"></div>
        <div data-editor class="w-col" style="gap:4px;display:none">
          <div class="w-row" style="gap:5px">
            <input data-name class="search" placeholder="Name" style="margin:0;padding:4px 7px;font-size:11px;flex:1;min-width:0" />
            <input data-target class="search" placeholder="Path, exe or URL" style="margin:0;padding:4px 7px;font-size:11px;flex:1.4;min-width:0" />
            <button data-add class="w-btn" style="padding:4px 8px">${icons.plus}</button>
          </div>
          <div class="w-faint" style="font-size:10px">Click a tile to launch. Use × to remove.</div>
        </div>
      </div>`;

    const grid = body.querySelector<HTMLElement>("[data-grid]")!;
    const count = body.querySelector<HTMLElement>("[data-count]")!;
    const editor = body.querySelector<HTMLElement>("[data-editor]")!;
    const editBtn = body.querySelector<HTMLButtonElement>("[data-edit]")!;
    const nameInput = body.querySelector<HTMLInputElement>("[data-name]")!;
    const targetInput = body.querySelector<HTMLInputElement>("[data-target]")!;
    const addBtn = body.querySelector<HTMLButtonElement>("[data-add]")!;

    const persist = (): void => ctx.setSettings({ apps });

    const render = (): void => {
      grid.classList.toggle("editing", editing);
      count.textContent = apps.length ? `${apps.length}` : "";
      grid.innerHTML = "";
      apps.forEach((app, i) => {
        const btn = document.createElement("button");
        btn.className = "al-app";
        btn.type = "button";
        btn.title = `${app.name} — ${app.target}`;
        btn.innerHTML = `
          <span class="al-glyph">${glyphFor(app.name, app.target)}</span>
          <span class="al-lbl">${esc(app.name)}</span>
          <span class="al-x" role="button" title="Remove">×</span>`;
        btn.addEventListener("click", () => {
          void ctx.invoke("open_path", { path: app.target }).catch(() => {});
        });
        const x = btn.querySelector<HTMLElement>(".al-x")!;
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          apps.splice(i, 1);
          persist();
          render();
        });
        grid.appendChild(btn);
      });
      if (!apps.length) {
        const empty = document.createElement("div");
        empty.className = "w-faint";
        empty.style.cssText = "font-size:10px;grid-column:1/-1;text-align:center;padding:6px 0";
        empty.textContent = editing ? "No shortcuts — add one below." : "No shortcuts.";
        grid.appendChild(empty);
      }
    };

    const add = (): void => {
      const name = nameInput.value.trim();
      const target = targetInput.value.trim();
      if (!name || !target) return;
      apps.push({ name, target });
      nameInput.value = "";
      targetInput.value = "";
      persist();
      render();
    };

    editBtn.addEventListener("click", () => {
      editing = !editing;
      editBtn.textContent = editing ? "Done" : "Edit";
      editor.style.display = editing ? "flex" : "none";
      render();
    });
    addBtn.addEventListener("click", add);
    for (const input of [nameInput, targetInput]) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") add();
      });
    }

    body.appendChild(style);

    render();

    const unsub = ctx.onSettings((s) => {
      const next = parseApps(s.apps);
      if (JSON.stringify(next) !== JSON.stringify(apps)) {
        apps = next;
        render();
      }
    });

    return { destroy: () => unsub() };
  },
};

export default mod;
