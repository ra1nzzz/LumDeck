// Persistence for dock preferences and the widget layout.
//
// Layout + preferences live in localStorage so they survive restarts without a
// server. Per-widget small state can live here too; heavier state (screen time,
// caches) lives in the Rust backend.

export type DockStyle = "black" | "white" | "liquid" | "ios" | "midnight";
export type DockSize = "sm" | "md" | "lg";
export type DockEdge = "top" | "bottom";

export interface PlacedWidget {
  /** Unique per placed instance (a widget can appear more than once). */
  uid: string;
  widgetId: string;
  size: { w: number; h: number };
  settings: Record<string, unknown>;
}

export interface DockPrefs {
  style: DockStyle;
  size: DockSize;
  edge: DockEdge;
  autoHideTaskbar: boolean;
  layout: PlacedWidget[];
}

const KEY = "lumdeck.state.v1";

const DEFAULTS: DockPrefs = {
  style: "liquid",
  size: "md",
  edge: "bottom",
  autoHideTaskbar: false,
  layout: [],
};

const STYLES: DockStyle[] = ["black", "white", "liquid", "ios", "midnight"];
const SIZES: DockSize[] = ["sm", "md", "lg"];
const EDGES: DockEdge[] = ["top", "bottom"];

function oneOf<T extends string>(v: unknown, allowed: T[], fallback: T): T {
  return typeof v === "string" && (allowed as string[]).includes(v) ? (v as T) : fallback;
}

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
}

// A malformed or version-skewed persisted entry must never crash boot().
function normalizePlaced(p: unknown): PlacedWidget | null {
  if (!p || typeof p !== "object") return null;
  const o = p as Record<string, unknown>;
  if (typeof o.uid !== "string" || typeof o.widgetId !== "string") return null;
  const size = o.size && typeof o.size === "object" ? (o.size as Record<string, unknown>) : {};
  const settings =
    o.settings && typeof o.settings === "object" ? (o.settings as Record<string, unknown>) : {};
  return {
    uid: o.uid,
    widgetId: o.widgetId,
    size: { w: clampInt(size.w, 1, 6, 2), h: clampInt(size.h, 1, 4, 1) },
    settings,
  };
}

function load(): DockPrefs {
  const base = structuredClone(DEFAULTS);
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<DockPrefs>;
    return {
      style: oneOf(parsed.style, STYLES, base.style),
      size: oneOf(parsed.size, SIZES, base.size),
      edge: oneOf(parsed.edge, EDGES, base.edge),
      autoHideTaskbar:
        typeof parsed.autoHideTaskbar === "boolean" ? parsed.autoHideTaskbar : base.autoHideTaskbar,
      layout: Array.isArray(parsed.layout)
        ? parsed.layout.map(normalizePlaced).filter((p): p is PlacedWidget => p !== null)
        : [],
    };
  } catch {
    return base;
  }
}

let state: DockPrefs = load();
const listeners = new Set<(s: DockPrefs) => void>();

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage full / disabled — keep in-memory only */
  }
  for (const l of listeners) l(state);
}

export const store = {
  get(): DockPrefs {
    return state;
  },
  subscribe(fn: (s: DockPrefs) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  setPrefs(patch: Partial<Omit<DockPrefs, "layout">>): void {
    const next = { ...state, ...patch };
    next.style = oneOf(next.style, STYLES, DEFAULTS.style);
    next.size = oneOf(next.size, SIZES, DEFAULTS.size);
    next.edge = oneOf(next.edge, EDGES, DEFAULTS.edge);
    state = next;
    persist();
  },
  setLayout(layout: PlacedWidget[]): void {
    state = { ...state, layout };
    persist();
  },
  addWidget(placed: PlacedWidget, index?: number): void {
    const layout = [...state.layout];
    if (index === undefined) layout.push(placed);
    else layout.splice(index, 0, placed);
    this.setLayout(layout);
  },
  removeWidget(uid: string): void {
    this.setLayout(state.layout.filter((p) => p.uid !== uid));
  },
  updateWidget(uid: string, patch: Partial<PlacedWidget>): void {
    this.setLayout(
      state.layout.map((p) => (p.uid === uid ? { ...p, ...patch } : p)),
    );
  },
  moveWidget(from: number, to: number): void {
    const layout = [...state.layout];
    if (from < 0 || from >= layout.length) return;
    const [item] = layout.splice(from, 1);
    layout.splice(Math.max(0, Math.min(layout.length, to)), 0, item);
    this.setLayout(layout);
  },
  widgetSettings(uid: string): Record<string, unknown> {
    return state.layout.find((p) => p.uid === uid)?.settings ?? {};
  },
  setWidgetSettings(uid: string, settings: Record<string, unknown>): void {
    this.updateWidget(uid, { settings });
  },
};

let uidCounter = 0;
export function newUid(widgetId: string): string {
  uidCounter += 1;
  return `${widgetId}-${Date.now().toString(36)}-${uidCounter}`;
}
