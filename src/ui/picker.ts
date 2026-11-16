import { GROUPS } from "../core/groups";
import { registry } from "../core/registry";
import { newUid, store } from "../core/store";
import type { GroupId, WidgetModule } from "../core/types";

let isOpen = false;

export function openPicker(): void {
  if (isOpen) return;
  isOpen = true;

  let filter: GroupId | "all" = "all";
  let query = "";

  const overlay = document.createElement("div");
  overlay.className = "overlay no-drag";

  const panel = document.createElement("div");
  panel.className = "panel";
  panel.style.position = "relative";

  const side = document.createElement("div");
  side.className = "panel-side";

  const search = document.createElement("input");
  search.className = "search";
  search.placeholder = "Search widgets";
  search.addEventListener("input", () => {
    query = search.value.trim().toLowerCase();
    renderMain();
  });
  side.appendChild(search);

  const main = document.createElement("div");
  main.className = "panel-main";

  const closeBtn = document.createElement("button");
  closeBtn.className = "panel-close";
  closeBtn.type = "button";
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", close);
  panel.appendChild(closeBtn);

  function renderSide(): void {
    side.querySelectorAll(".cat").forEach((n) => n.remove());
    const cats: { id: GroupId | "all"; name: string; icon: string; n: number }[] = [
      { id: "all", name: "All Widgets", icon: GROUPS[0].icon, n: registry.all().length },
      ...GROUPS.map((g) => ({
        id: g.id,
        name: g.name,
        icon: g.icon,
        n: registry.byGroup(g.id).length,
      })),
    ];
    for (const c of cats) {
      const el = document.createElement("div");
      el.className = "cat" + (filter === c.id ? " active" : "");
      el.innerHTML = `<span class="ico">${c.icon}</span><span>${c.name}</span><span class="n">${c.n}</span>`;
      el.addEventListener("click", () => {
        filter = c.id;
        renderSide();
        renderMain();
      });
      side.appendChild(el);
    }
  }

  function matches(m: WidgetModule): boolean {
    if (filter !== "all" && m.group !== filter) return false;
    if (query && !(`${m.name} ${m.description ?? ""}`.toLowerCase().includes(query))) return false;
    return true;
  }

  function addWidget(m: WidgetModule): void {
    store.addWidget({
      uid: newUid(m.id),
      widgetId: m.id,
      size: { ...m.defaultSize },
      settings: {},
    });
    close();
  }

  function card(m: WidgetModule): HTMLElement {
    const el = document.createElement("div");
    el.className = "wcard";
    el.innerHTML = `<span class="ico">${m.icon}</span><span class="nm">${m.name}</span>${
      m.description ? `<span class="ds">${m.description}</span>` : ""
    }`;
    el.addEventListener("click", () => addWidget(m));
    return el;
  }

  function renderMain(): void {
    main.innerHTML = "";
    const all = registry.all();
    const inBar = store.get().layout.length;
    const h = document.createElement("h2");
    h.innerHTML = `${filter === "all" ? "All Widgets" : GROUPS.find((g) => g.id === filter)?.name} <span style="font-weight:400;color:var(--text-dim)">· ${all.length} total · ${inBar} in bar</span>`;
    main.appendChild(h);

    const list = all.filter(matches);
    if (list.length === 0) {
      const e = document.createElement("div");
      e.className = "w-dim";
      e.textContent = "No widgets match.";
      main.appendChild(e);
      return;
    }
    const grid = document.createElement("div");
    grid.className = "wgrid";
    for (const m of list) grid.appendChild(card(m));
    main.appendChild(grid);
  }

  panel.appendChild(side);
  panel.appendChild(main);
  overlay.appendChild(panel);

  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) close();
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  window.addEventListener("keydown", onKey);

  function close(): void {
    window.removeEventListener("keydown", onKey);
    overlay.remove();
    isOpen = false;
  }

  renderSide();
  renderMain();
  document.body.appendChild(overlay);
  search.focus();
}
