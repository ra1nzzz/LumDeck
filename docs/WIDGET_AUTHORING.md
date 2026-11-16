# LumDeck widget authoring guide

LumDeck is a clean-room live widget dock for Windows: a Tauri app (Rust backend +
vanilla-TypeScript frontend). Each widget is an independent module. The framework
owns the tile chrome; a widget owns only the content inside its `body` element and
its own data + DOM.

## The contract

Every widget file **default-exports** a `WidgetModule` (see `src/core/types.ts`):

```ts
import type { WidgetModule } from "../../core/types";

const mod: WidgetModule = {
  id: "my-widget",            // unique, kebab-case
  name: "My Widget",          // shown in the picker
  group: "system",            // one of the 12 GroupIds
  description: "One line",    // optional
  icon: icons.cpu,            // inline SVG string (see icons below)
  defaultSize: { w: 3, h: 1 },// w in tile-units (1..4), h in rows (1..2)
  refreshMs: 2000,            // optional auto-refresh cadence (ms)
  mount(body, ctx) {          // build into `body`; return an instance
    body.innerHTML = `...`;
    return { refresh() {}, destroy() {} };
  },
};
export default mod;
```

`mount` may be `async`. The returned instance may implement:
- `refresh(): void | Promise<void>` — called every `refreshMs` (and you may call it yourself).
- `resize(w, h)` — called on tile resize (optional).
- `destroy()` — clear timers/listeners here.

### `ctx` (WidgetContext)

- `ctx.invoke<T>(cmd, args?)` — call a Rust command. **Rejects on failure — always try/catch.**
- `ctx.settings` — current persisted settings bag for this instance (read-only snapshot).
- `ctx.setSettings(patch)` — merge + persist settings.
- `ctx.onSettings(handler)` — subscribe to changes; returns an unsubscribe function.

Persist credentials / options with `ctx.setSettings({ key: "value" })` and read them
from `ctx.settings`. When a required credential is missing, render a small
"connect" affordance instead of throwing.

## File layout & registration

Create one file per widget at `src/widgets/<group>/<kebab-id>.widget.ts`.
Files ending in `.widget.ts` are **auto-registered** — never edit `index.ts`.

Groups (folder names): `clocks productivity system media ai analytics social
stocks finance weather online apps`.

## Icons

Import from `src/widgets/icons.ts`:

```ts
import { icons } from "../icons";       // adjust ../ depth for your folder
```

Available: `clock globe cpu memory battery bolt wifi music play pause check plus
note timer calendar cloud sun trend cash star mail spark users folder grid volume
sliders`. Need a different glyph? Inline your own `<svg>…</svg>` string in the
widget file — **do not edit `icons.ts`.**

## CSS utility classes (already styled; compose freely)

Layout: `w-row` (flex row, gap 7) · `w-col` (flex column) · `w-spacer` (flex:1)
Text: `w-title` (small label) · `w-big` (large) · `w-value` (medium) ·
`w-dim` / `w-faint` (muted) · `w-mono` (tabular numbers)
Color: `w-accent` · `w-good` · `w-warn` · `w-bad`
Bits: `w-icon` (18px svg box) · `w-btn` (small button) · `w-error` (small error text)
Charts: `w-bars` (bar sparkline — append `<i style="height:X%">` children) ·
`w-gauge` (circular gauge, see `system/stats.widget.ts` for the SVG pattern)
Controls: `w-slider` (styled range input) — remember to read/write via the Rust
command, not just visually.

Inline styles are fine for one-offs. Keep the dark-glass aesthetic: rounded,
compact, an icon + a big value + a small label is the house style.

## Rust command reference

Call with `await ctx.invoke("name", { ...args })`. Handle rejection.

Available now:
- `system_stats() -> { cpu: f32, ram: f32, ram_used_gb: f32, ram_total_gb: f32, battery: u8|null, charging: bool, on_ac: bool, has_battery: bool }`
- `net_connected() -> bool`
- `dock_position`, `taskbar_autohide` (framework-only — don't call from widgets)

Reserved (may be added later — degrade gracefully if the call rejects today):
- `volume_get() -> { level: f32 (0..1), muted: bool, device: string }`
- `volume_set({ level: f32 })` · `volume_toggle_mute()`
- `brightness_get() -> u8 (0..100)` · `brightness_set({ level: u8 })`
- `now_playing() -> { title, artist, source, playing } | null`
- `media_control({ action: "play"|"pause"|"next"|"prev"|"toggle" })`
- `net_speed() -> { down_bps: u64, up_bps: u64 }`
- `open_path({ path: string })` — launch a file/app/URL

For network data you may also call CORS-friendly public APIs directly with
`fetch()` (e.g. Open-Meteo weather, exchangerate hosts). Always handle failures.

## Golden rules

- Self-contained, strict-TypeScript clean. No edits to shared files.
- Never throw uncaught from `refresh`/`mount`; show a small fallback instead.
- Reasonable `defaultSize` and `refreshMs`. Clean up timers in `destroy`.
- After writing, run `cd /d/Code/LumDeck && npx tsc --noEmit` and fix errors in
  your own files only. Do not run `vite build` or `cargo`. Do not add doc files.
