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
  /** Current persisted settings for this widget instance. */
  readonly settings: SettingsBag;
  /** Patch and persist settings for this widget instance. */
  setSettings: (patch: SettingsBag) => void;
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
