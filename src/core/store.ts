// Persistence for dock preferences and the widget layout.
//
// Layout + non-sensitive preferences live in localStorage so they survive
// restarts without a server. Widget secrets belong to the OS credential vault
// (`src/core/credentials.ts`), never to general settings.

import {
  extractLegacySecrets,
  stripSecretSettings,
  type CredentialStorePort,
  type PersistResult,
} from "./credentials";

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

function isNonEmptyId(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

// A malformed or version-skewed persisted entry must never crash boot().
function normalizePlaced(
  p: unknown,
): { placed: PlacedWidget; legacy: Record<string, unknown> } | null {
  if (!p || typeof p !== "object") return null;
  const o = p as Record<string, unknown>;
  if (!isNonEmptyId(o.uid) || !isNonEmptyId(o.widgetId)) return null;
  const size = o.size && typeof o.size === "object" ? (o.size as Record<string, unknown>) : {};
  const rawSettings =
    o.settings && typeof o.settings === "object" ? (o.settings as Record<string, unknown>) : {};
  const { cleanSettings, legacySecrets } = extractLegacySecrets(o.widgetId, rawSettings);
  return {
    placed: {
      uid: o.uid,
      widgetId: o.widgetId,
      size: { w: clampInt(size.w, 1, 6, 2), h: clampInt(size.h, 1, 4, 1) },
      settings: cleanSettings,
    },
    legacy: legacySecrets,
  };
}

// Quarantine unmigrated legacy secrets out of public PlacedWidget.settings so
// general settings updates never see or copy them, while disk persistence
// preserves them until the credential adapter confirms Vault write + cleanup.
const pendingLegacy = new Map<string, Record<string, unknown>>();

function dedupeSanitizedLayout(rawLayout: unknown[]): PlacedWidget[] {
  const seen = new Set<string>();
  const out: PlacedWidget[] = [];
  for (const item of rawLayout) {
    if (!item || typeof item !== "object") continue;
    const p = item as PlacedWidget;
    if (!isNonEmptyId(p.uid) || !isNonEmptyId(p.widgetId)) continue;
    if (seen.has(p.uid)) continue;
    seen.add(p.uid);
    out.push({
      uid: p.uid,
      widgetId: p.widgetId,
      size: { w: clampInt(p.size?.w, 1, 6, 2), h: clampInt(p.size?.h, 1, 4, 1) },
      settings: stripSecretSettings(
        p.widgetId,
        p.settings && typeof p.settings === "object" ? p.settings : {},
      ),
    });
  }
  return out;
}

function load(): DockPrefs {
  const base = structuredClone(DEFAULTS);
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<DockPrefs>;
    const seen = new Set<string>();
    const layout: PlacedWidget[] = [];
    if (Array.isArray(parsed.layout)) {
      for (const item of parsed.layout) {
        const entry = normalizePlaced(item);
        if (!entry) continue;
        // Stable deduplication: preserve the first valid UID and its credentials.
        if (seen.has(entry.placed.uid)) continue;
        seen.add(entry.placed.uid);
        layout.push(entry.placed);
        if (Object.keys(entry.legacy).length > 0) {
          pendingLegacy.set(entry.placed.uid, entry.legacy);
        }
      }
    }
    return {
      style: oneOf(parsed.style, STYLES, base.style),
      size: oneOf(parsed.size, SIZES, base.size),
      edge: oneOf(parsed.edge, EDGES, base.edge),
      autoHideTaskbar:
        typeof parsed.autoHideTaskbar === "boolean" ? parsed.autoHideTaskbar : base.autoHideTaskbar,
      layout,
    };
  } catch {
    return base;
  }
}

let state: DockPrefs = load();
const listeners = new Set<(s: DockPrefs) => void>();

function serializeState(
  prefs: DockPrefs,
  legacyMap: ReadonlyMap<string, Record<string, unknown>>,
): string {
  const serialized: DockPrefs = {
    ...prefs,
    layout: prefs.layout.map((p) => {
      const legacy = legacyMap.get(p.uid);
      if (!legacy || Object.keys(legacy).length === 0) return p;
      return {
        ...p,
        settings: { ...p.settings, ...legacy },
      };
    }),
  };
  return JSON.stringify(serialized);
}

function tryPersist(
  prefs: DockPrefs = state,
  legacyMap: ReadonlyMap<string, Record<string, unknown>> = pendingLegacy,
): PersistResult {
  try {
    localStorage.setItem(KEY, serializeState(prefs, legacyMap));
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error && err.message ? err.message : "storage write failed",
    };
  }
}

function notify(): void {
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
  setPrefs(patch: Partial<Omit<DockPrefs, "layout">>): PersistResult {
    const next = { ...state, ...patch };
    next.style = oneOf(next.style, STYLES, DEFAULTS.style);
    next.size = oneOf(next.size, SIZES, DEFAULTS.size);
    next.edge = oneOf(next.edge, EDGES, DEFAULTS.edge);
    state = next;
    const res = tryPersist();
    notify();
    return res;
  },
  setLayout(layout: PlacedWidget[]): PersistResult {
    const nextLayout = dedupeSanitizedLayout(layout);
    const keep = new Set(nextLayout.map((p) => p.uid));
    state = { ...state, layout: nextLayout };
    const res = tryPersist();
    if (res.ok) {
      for (const uid of pendingLegacy.keys()) {
        if (!keep.has(uid)) pendingLegacy.delete(uid);
      }
    }
    notify();
    return res;
  },
  addWidget(placed: PlacedWidget, index?: number): PersistResult {
    if (!isNonEmptyId(placed.uid) || !isNonEmptyId(placed.widgetId)) {
      return { ok: false, error: "invalid widget entry" };
    }
    if (state.layout.some((p) => p.uid === placed.uid)) {
      return { ok: false, error: "duplicate widget uid" };
    }
    const clean: PlacedWidget = {
      uid: placed.uid,
      widgetId: placed.widgetId,
      size: { w: clampInt(placed.size?.w, 1, 6, 2), h: clampInt(placed.size?.h, 1, 4, 1) },
      settings: stripSecretSettings(
        placed.widgetId,
        placed.settings && typeof placed.settings === "object" ? placed.settings : {},
      ),
    };
    const layout = [...state.layout];
    if (index === undefined) layout.push(clean);
    else layout.splice(index, 0, clean);
    return this.setLayout(layout);
  },
  removeWidget(uid: string): PersistResult {
    const nextLayout = state.layout.filter((p) => p.uid !== uid);
    if (nextLayout.length === state.layout.length) return { ok: true };
    const nextState: DockPrefs = { ...state, layout: nextLayout };
    const nextLegacy = new Map(pendingLegacy);
    nextLegacy.delete(uid);
    const res = tryPersist(nextState, nextLegacy);
    if (!res.ok) {
      // Roll back so failed layout persistence leaves the tile and retry affordance intact.
      return res;
    }
    state = nextState;
    pendingLegacy.delete(uid);
    notify();
    return { ok: true };
  },
  updateWidget(uid: string, patch: Partial<PlacedWidget>): PersistResult {
    const nextLayout = state.layout.map((p) => {
      if (p.uid !== uid) return p;
      const widgetId = isNonEmptyId(patch.widgetId) ? patch.widgetId : p.widgetId;
      const settings =
        patch.settings && typeof patch.settings === "object"
          ? stripSecretSettings(widgetId, patch.settings)
          : p.settings;
      const size = patch.size
        ? { w: clampInt(patch.size.w, 1, 6, p.size.w), h: clampInt(patch.size.h, 1, 4, p.size.h) }
        : p.size;
      // Never rewrite an existing widget's UID into a new credential namespace.
      return { ...p, widgetId, size, settings };
    });
    state = { ...state, layout: nextLayout };
    const res = tryPersist();
    notify();
    return res;
  },
  moveWidget(from: number, to: number): PersistResult {
    const layout = [...state.layout];
    if (from < 0 || from >= layout.length) return { ok: true };
    const [item] = layout.splice(from, 1);
    layout.splice(Math.max(0, Math.min(layout.length, to)), 0, item);
    return this.setLayout(layout);
  },
  widgetSettings(uid: string): Record<string, unknown> {
    return state.layout.find((p) => p.uid === uid)?.settings ?? {};
  },
  setWidgetSettings(uid: string, settings: Record<string, unknown>): PersistResult {
    const target = state.layout.find((p) => p.uid === uid);
    if (!target) return { ok: false, error: "widget not found" };
    return this.updateWidget(uid, {
      settings: stripSecretSettings(target.widgetId, settings),
    });
  },
  hasLegacySecret(uid: string, legacyKey: string): boolean {
    const rec = pendingLegacy.get(uid);
    return rec ? Object.prototype.hasOwnProperty.call(rec, legacyKey) : false;
  },
  getLegacySecret(uid: string, legacyKey: string): unknown {
    return pendingLegacy.get(uid)?.[legacyKey];
  },
  commitLegacySecretCleared(uid: string, legacyKey: string): PersistResult {
    const cur = pendingLegacy.get(uid);
    if (!cur || !Object.prototype.hasOwnProperty.call(cur, legacyKey)) {
      return { ok: true };
    }
    const nextEntry = { ...cur };
    delete nextEntry[legacyKey];
    const nextLegacy = new Map(pendingLegacy);
    if (Object.keys(nextEntry).length > 0) nextLegacy.set(uid, nextEntry);
    else nextLegacy.delete(uid);

    const res = tryPersist(state, nextLegacy);
    if (!res.ok) return res;

    if (Object.keys(nextEntry).length > 0) pendingLegacy.set(uid, nextEntry);
    else pendingLegacy.delete(uid);
    return { ok: true };
  },
};

export const storeCredentialPort: CredentialStorePort = {
  getWidgetId: (uid) => state.layout.find((p) => p.uid === uid)?.widgetId,
  hasLegacySecret: (uid, legacyKey) => store.hasLegacySecret(uid, legacyKey),
  getLegacySecret: (uid, legacyKey) => store.getLegacySecret(uid, legacyKey),
  commitLegacySecretCleared: (uid, legacyKey) => store.commitLegacySecretCleared(uid, legacyKey),
};

let uidCounter = 0;
export function newUid(widgetId: string): string {
  let candidate: string;
  do {
    uidCounter += 1;
    candidate = `${widgetId}-${Date.now().toString(36)}-${uidCounter}`;
  } while (state.layout.some((p) => p.uid === candidate));
  return candidate;
}
