// LumDeck widget contract.
//
// Every widget is an independent module that implements `WidgetModule`.
// The framework owns the tile chrome (frame, glass background, drag handle,
// size, refresh scheduling). A widget only owns the content inside its body
// element and its own data fetching / DOM updates.

export type GroupId =
  | "clocks"
  | "productivity"
  | "system"
  | "apps"
  | "media"
  | "ai"
  | "analytics"
  | "social"
  | "stocks"
  | "finance"
  | "weather"
  | "online";

export type SettingsBag = Record<string, unknown>;

/** Handed to every widget so it can call the Rust backend and persist its own settings. */
export interface WidgetContext {
  /** Call a Tauri command. Rejects with a normal Error on failure. */
  invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  /** This placed instance's stable id (use it to namespace secrets). */
  readonly uid: string;
  /** Current persisted NON-secret settings for this widget instance. */
  readonly settings: SettingsBag;
  /** Merge + persist NON-secret settings for this widget instance. */
  setSettings: (patch: SettingsBag) => void;
  /**
   * Store a SECRET (API key / token / OAuth token) in the OS credential vault
   * (Windows Credential Manager via the Rust backend), namespaced to this
   * instance. NEVER persist secrets via setSettings — that lands in plaintext
   * localStorage. Resolves even when the backend is unavailable (dev/browser).
   */
  setSecret: (key: string, value: string) => Promise<void>;
  /** Read a previously stored secret, or null if absent/unavailable. */
  getSecret: (key: string) => Promise<string | null>;
  /** Remove a stored secret. */
  deleteSecret: (key: string) => Promise<void>;
  /** Subscribe to settings changes (including external). Returns an unsubscribe fn. */
  onSettings: (handler: (settings: SettingsBag) => void) => () => void;
}

/** Returned by `mount`; the framework drives `refresh` on the widget's cadence. */
export interface WidgetInstance {
  refresh?: () => void | Promise<void>;
  resize?: (w: number, h: number) => void;
  destroy?: () => void;
}

export interface WidgetModule {
  /** Unique, kebab-case id. */
  id: string;
  /** Human-readable name shown in the picker. */
  name: string;
  group: GroupId;
  description?: string;
  /** Inline SVG string (preferred) or a short emoji fallback. */
  icon: string;
  /** Default tile size in tile units. */
  defaultSize: { w: number; h: number };
  /** Milliseconds between automatic refreshes. Omit for manual/event-driven only. */
  refreshMs?: number;
  /** Build the widget into `body`. May be async (e.g. first data load). */
  mount: (body: HTMLElement, ctx: WidgetContext) => WidgetInstance | Promise<WidgetInstance>;
}
