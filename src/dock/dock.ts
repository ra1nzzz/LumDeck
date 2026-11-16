import { store, type DockEdge, type DockPrefs, type DockSize, type PlacedWidget } from "../core/store";
import { hasTauri as moduleHasTauri, invoke, listen } from "../core/tauri";
import { renderTile } from "./tile";
import { openPicker } from "../ui/picker";
import { openSettings } from "../ui/settings";

let inner: HTMLElement;
let root: HTMLElement;
let lastSignature = "";
let lastEdge: DockEdge | null = null;
let lastSize: DockSize | null = null;
let lastSentGeomKey = "";
let repositionInFlight: Promise<void> | null = null;
let repositionQueued = false;
let taskbarTogglePending = false;
let bootCleanup: (() => void) | null = null;
// uid -> mounted tile element, so reorders/updates can be reconciled without
// destroying and re-mounting every widget.
const mounted = new Map<string, HTMLElement>();

const DEFAULT_DOCK_H: Record<DockSize, number> = { sm: 58, md: 76, lg: 96 };

function isTauriRuntime(): boolean {
  if (moduleHasTauri === true) return true;
  if (
    typeof window !== "undefined" &&
    ("__TAURI__" in window || "__TAURI_INTERNALS__" in window)
  ) {
    return true;
  }
  // Support partial test mocks of core/tauri that export invoke without hasTauri.
  return moduleHasTauri === undefined;
}

export function boot(): void {
  bootCleanup?.();
  bootCleanup = null;

  for (const el of mounted.values()) {
    (el as unknown as { __destroy?: () => void }).__destroy?.();
  }
  mounted.clear();
  lastSignature = "";
  lastEdge = null;
  lastSize = null;
  lastSentGeomKey = "";
  repositionInFlight = null;
  repositionQueued = false;
  taskbarTogglePending = false;

  const app = document.getElementById("app")!;
  app.innerHTML = "";

  const initial = store.get();
  root = document.createElement("div");
  root.className = "window-root drag-region";
  root.dataset.edge = initial.edge;

  const dock = document.createElement("div");
  dock.className = "dock drag-region";
  dock.id = "dock";

  inner = document.createElement("div");
  inner.className = "dock-inner";
  dock.appendChild(inner);
  root.appendChild(dock);
  app.appendChild(root);

  applyPrefs(initial);
  lastEdge = initial.edge;
  lastSize = initial.size;
  renderTiles();

  const lifecycleAc = new AbortController();
  const unsubStore = store.subscribe(onStoreChange);
  const unsubScale = watchScaleChange(() => {
    void reposition();
  });
  enableDrag(lifecycleAc.signal);
  wireContextMenu(dock);
  const unsubTray = wireTray();

  bootCleanup = () => {
    lifecycleAc.abort();
    unsubStore();
    unsubScale();
    unsubTray();
  };

  void reposition();
  void applyTaskbar();
}

function applyPrefs(prefs: DockPrefs): void {
  document.documentElement.dataset.style = prefs.style;
  document.documentElement.dataset.size = prefs.size;
  root.dataset.edge = prefs.edge;
}

// Signature = uid + size, IN ORDER. Settings-only changes deliberately do NOT
// change it (widgets update themselves via ctx.onSettings), so this must stay
// free of anything that changes on a settings write.
function signature(layout: PlacedWidget[]): string {
  return layout.map((p) => `${p.uid}:${p.size.w}x${p.size.h}`).join("|");
}

function onStoreChange(prefs: DockPrefs): void {
  applyPrefs(prefs);
  const sig = signature(prefs.layout);
  if (sig !== lastSignature) {
    renderTiles();
  }
  if (prefs.edge !== lastEdge || prefs.size !== lastSize) {
    lastEdge = prefs.edge;
    lastSize = prefs.size;
    void reposition();
  }
}

function renderTiles(): void {
  const layout = store.get().layout;
  lastSignature = signature(layout);

  const desired = new Set(layout.map((p) => p.uid));

  // Destroy + drop tiles that left the layout.
  for (const [uid, el] of mounted) {
    if (!desired.has(uid)) {
      (el as unknown as { __destroy?: () => void }).__destroy?.();
      el.remove();
      mounted.delete(uid);
    }
  }

  // Empty-state placeholder.
  let empty = inner.querySelector<HTMLElement>(".dock-empty");
  if (layout.length === 0) {
    if (!empty) {
      empty = document.createElement("div");
      empty.className = "dock-empty w-dim";
      empty.style.cssText = "margin:auto;font-size:12px;";
      empty.textContent = "Right-click to add widgets";
      inner.appendChild(empty);
    }
    return;
  } else if (empty) {
    empty.remove();
  }

  // Create any new tiles, then appendChild every tile in layout order. For
  // already-mounted nodes appendChild simply re-positions them, so a reorder
  // never re-mounts (and never re-fetches) a widget.
  for (const placed of layout) {
    let el = mounted.get(placed.uid);
    if (!el) {
      el = renderTile(placed);
      mounted.set(placed.uid, el);
    } else {
      el.style.setProperty("--w", String(placed.size.w));
    }
    inner.appendChild(el);
  }
}

// Returns logical CSS pixel height; Rust scales to physical pixels using the target monitor's scale factor.
function dockHeightPx(size: DockSize): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--dock-h");
  return (parseInt(v, 10) || DEFAULT_DOCK_H[size]) + 12;
}

function currentScale(): number {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio : 1;
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}

function watchScaleChange(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  let stopCurrent: (() => void) | null = null;
  let active = true;

  const observe = () => {
    stopCurrent?.();
    stopCurrent = null;
    if (!active) return;
    const mql = window.matchMedia(`(resolution: ${currentScale()}dppx)`);
    if (!mql || typeof mql.addEventListener !== "function") return;
    const onDprChange = () => {
      if (!active) return;
      observe();
      onChange();
    };
    mql.addEventListener("change", onDprChange, { once: true });
    stopCurrent = () => mql.removeEventListener("change", onDprChange);
  };

  observe();
  return () => {
    active = false;
    stopCurrent?.();
    stopCurrent = null;
  };
}

async function reposition(): Promise<void> {
  if (!isTauriRuntime()) return;
  if (repositionInFlight) {
    // Coalesce rapid edge/size/scale updates into a single follow-up IPC call.
    repositionQueued = true;
    return;
  }

  const prefs = store.get();
  const heightPx = dockHeightPx(prefs.size);
  const geomKey = `${prefs.edge}:${prefs.size}:${heightPx}:${currentScale()}`;
  if (geomKey === lastSentGeomKey) return;

  lastSentGeomKey = geomKey;
  const task = (async () => {
    try {
      await invoke("dock_position", { edge: prefs.edge, heightPx });
    } catch {
      if (lastSentGeomKey === geomKey) {
        lastSentGeomKey = "";
      }
    }
  })();
  repositionInFlight = task;
  await task;
  repositionInFlight = null;

  if (repositionQueued) {
    repositionQueued = false;
    await reposition();
  }
}

async function applyTaskbar(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await invoke("taskbar_autohide", { enabled: store.get().autoHideTaskbar });
  } catch {
    /* ignore */
  }
}

async function toggleTaskbarAutoHide(): Promise<void> {
  if (taskbarTogglePending) return;
  const next = !store.get().autoHideTaskbar;
  taskbarTogglePending = true;
  try {
    if (isTauriRuntime()) {
      await invoke("taskbar_autohide", { enabled: next });
    }
    store.setPrefs({ autoHideTaskbar: next });
  } catch {
    /* keep prior autoHideTaskbar preference when native update fails */
  } finally {
    taskbarTogglePending = false;
  }
}

// ---- Drag to reorder ------------------------------------------------------
function enableDrag(signal: AbortSignal): void {
  let dragUid: string | null = null;
  let startX = 0;
  let startY = 0;
  let active = false;
  let targetIndex = -1;

  inner.addEventListener("pointerdown", (e) => {
    const grip = (e.target as HTMLElement).closest(".tile-grip") as HTMLElement | null;
    if (!grip) return;
    const tile = grip.closest(".tile") as HTMLElement | null;
    if (!tile?.dataset.uid) return;
    dragUid = tile.dataset.uid;
    startX = e.clientX;
    startY = e.clientY;
  });

  window.addEventListener(
    "pointermove",
    (e) => {
      if (!dragUid) return;
      if (!active && Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) > 5) {
        active = true;
        mounted.get(dragUid)?.classList.add("dragging");
      }
      if (!active) return;
      const tiles = [...inner.querySelectorAll<HTMLElement>(".tile:not(.dragging)")];
      let idx = tiles.length;
      for (let i = 0; i < tiles.length; i++) {
        const r = tiles[i].getBoundingClientRect();
        if (e.clientX < r.left + r.width / 2) {
          idx = i;
          break;
        }
      }
      inner.querySelectorAll(".tile.drop-target").forEach((el) => el.classList.remove("drop-target"));
      if (tiles[idx]) tiles[idx].classList.add("drop-target");
      targetIndex = idx;
    },
    { signal },
  );

  window.addEventListener(
    "pointerup",
    () => {
      if (!dragUid) return;
      mounted.get(dragUid)?.classList.remove("dragging");
      inner.querySelectorAll(".tile.drop-target").forEach((el) => el.classList.remove("drop-target"));
      if (active && targetIndex >= 0) {
        const layout = store.get().layout;
        const from = layout.findIndex((p) => p.uid === dragUid);
        // targetIndex already indexes the array with the dragged tile excluded,
        // which is exactly what moveWidget (splice-then-insert) expects.
        store.moveWidget(from, targetIndex);
      }
      dragUid = null;
      active = false;
      targetIndex = -1;
    },
    { signal },
  );
}

// ---- Right-click context menu --------------------------------------------
function wireContextMenu(dock: HTMLElement): void {
  dock.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY);
  });
}

function showMenu(x: number, y: number): void {
  closeMenu();
  const prefs = store.get();

  const menu = document.createElement("div");
  menu.className = "ctx no-drag";
  menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:80;min-width:190px;padding:6px;border-radius:12px;background:var(--glass-bg);backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%);border:1px solid var(--glass-border);box-shadow:0 20px 50px rgba(0,0,0,.45);color:var(--text);font-size:13px;`;

  const item = (label: string, onClick: () => void, extra?: string) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label + (extra ? `  ·  ${extra}` : "");
    b.style.cssText =
      "display:block;width:100%;text-align:left;border:none;background:transparent;color:inherit;padding:8px 10px;border-radius:8px;cursor:pointer;font-size:13px;";
    b.addEventListener("mouseenter", () => (b.style.background = "var(--tile-bg-hover)"));
    b.addEventListener("mouseleave", () => (b.style.background = "transparent"));
    b.addEventListener("click", () => {
      closeMenu();
      onClick();
    });
    return b;
  };

  menu.appendChild(item("Widgets…", () => openPicker()));
  menu.appendChild(item("Settings…", () => openSettings()));
  menu.appendChild(sep());
  menu.appendChild(item("Move to top edge", () => store.setPrefs({ edge: "top" }), prefs.edge === "top" ? "✓" : ""));
  menu.appendChild(item("Move to bottom edge", () => store.setPrefs({ edge: "bottom" }), prefs.edge === "bottom" ? "✓" : ""));
  menu.appendChild(sep());
  menu.appendChild(
    item("Auto-hide taskbar", () => {
      void toggleTaskbarAutoHide();
    }, prefs.autoHideTaskbar ? "on" : "off"),
  );
  menu.appendChild(sep());
  menu.appendChild(item("Quit LumDeck", () => void quit()));

  document.body.appendChild(menu);
  // Keep menu on-screen.
  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth) menu.style.left = `${window.innerWidth - r.width - 8}px`;
  if (r.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - r.height - 8}px`;

  // Dismiss on the next outside pointerdown. Guarding on the target (instead of
  // closing unconditionally) is essential: an unconditional close removes the
  // menu before the click is synthesized, so menu items would never fire.
  setTimeout(() => {
    const onDown = (e: PointerEvent) => {
      if (!menu.contains(e.target as Node)) closeMenu();
    };
    window.addEventListener("pointerdown", onDown, { once: true });
  }, 0);
}

function sep(): HTMLElement {
  const d = document.createElement("div");
  d.style.cssText = "height:1px;background:var(--glass-border);margin:5px 6px;";
  return d;
}

function closeMenu(): void {
  document.querySelectorAll(".ctx").forEach((m) => m.remove());
}

async function quit(): Promise<void> {
  if (!isTauriRuntime()) {
    window.close();
    return;
  }
  try {
    await invoke("quit_app");
  } catch {
    /* keep app state consistent if quit_app fails */
  }
}

function wireTray(): () => void {
  const unsubWidgets = listen("tray:widgets", () => openPicker());
  const unsubSettings = listen("tray:settings", () => openSettings());
  return () => {
    unsubWidgets();
    unsubSettings();
  };
}
