import { registry } from "../core/registry";
import { store, type PlacedWidget } from "../core/store";
import { invoke } from "../core/tauri";
import type { SettingsBag, WidgetContext, WidgetInstance } from "../core/types";

/** Build the DOM for one placed widget and mount its module into the body. */
export function renderTile(placed: PlacedWidget): HTMLElement {
  const mod = registry.get(placed.widgetId);

  const tile = document.createElement("div");
  tile.className = "tile no-drag";
  tile.dataset.uid = placed.uid;
  tile.dataset.widget = placed.widgetId;
  tile.style.setProperty("--w", String(placed.size.w));

  const body = document.createElement("div");
  body.className = "tile-body";
  tile.appendChild(body);

  const remove = document.createElement("button");
  remove.className = "tile-remove";
  remove.type = "button";
  remove.textContent = "×";
  remove.title = "Remove";
  remove.addEventListener("click", (e) => {
    e.stopPropagation();
    store.removeWidget(placed.uid);
  });
  tile.appendChild(remove);

  const grip = document.createElement("div");
  grip.className = "tile-grip";
  grip.title = "Drag to reorder";
  tile.appendChild(grip);

  if (!mod) {
    body.innerHTML = `<div class="w-error">missing<br>${escapeHtml(placed.widgetId)}</div>`;
    return tile;
  }

  const settings: SettingsBag = { ...placed.settings };
  const subs = new Set<(s: SettingsBag) => void>();
  const ctx: WidgetContext = {
    invoke,
    settings,
    setSettings: (patch) => {
      Object.assign(settings, patch);
      const snapshot = { ...settings };
      store.setWidgetSettings(placed.uid, snapshot);
      for (const h of subs) h(snapshot);
    },
    onSettings: (h) => {
      subs.add(h);
      return () => subs.delete(h);
    },
  };

  let instance: WidgetInstance | undefined;
  let timer = 0;
  let disposed = false;

  Promise.resolve()
    .then(() => mod.mount(body, ctx))
    .then((inst) => {
      // A layout change may have destroyed this tile while mount() was still
      // pending; if so, tear the late instance down and never start a timer on
      // a detached node.
      if (disposed) {
        try {
          inst?.destroy?.();
        } catch {
          /* ignore */
        }
        return;
      }
      instance = inst;
      if (mod.refreshMs && mod.refreshMs > 0) {
        timer = window.setInterval(() => {
          try {
            const r = instance?.refresh?.();
            if (r && typeof (r as Promise<void>).catch === "function") {
              (r as Promise<void>).catch(() => {});
            }
          } catch {
            /* a throwing refresh must not kill the interval loop */
          }
        }, mod.refreshMs);
      }
    })
    .catch((err) => {
      if (disposed) return;
      console.error(`[widget:${mod.id}] mount failed`, err);
      body.innerHTML = `<div class="w-error">failed to load</div>`;
    });

  // Cleanup hook used by the dock on structural re-render.
  (tile as unknown as { __destroy?: () => void }).__destroy = () => {
    disposed = true;
    if (timer) clearInterval(timer);
    try {
      instance?.destroy?.();
    } catch {
      /* ignore */
    }
  };

  return tile;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}
