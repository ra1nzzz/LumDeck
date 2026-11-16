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
- `refresh(): void | Promise<void>` — called automatically every `refreshMs` after the previous run settles (non-reentrant; you may also call it manually with your own in-flight guard).
- `resize(w, h)` — optional field on the `WidgetInstance` interface (`src/core/types.ts`), **not** invoked automatically by the framework on tile resize; use CSS layout or `ResizeObserver` if needed.
- `destroy()` — called once on unmount (or once if an async `mount` resolves after unmount); clear timers, animations, and listeners here.

### `ctx` (WidgetContext)

- `ctx.uid` — stable unique id for this placed tile instance (used to namespace secrets).
- `ctx.signal?: AbortSignal` — aborted as soon as the tile unmounts; pass it to network helpers and event listeners.
- `ctx.invoke<T>(cmd, args?)` — call a registered Rust command. **Rejects on failure or in browser preview — always handle rejections.**
- `ctx.settings` — current persisted **non-secret** settings bag for this instance (read-only snapshot).
- `ctx.setSettings(patch)` — merge + persist **non-secret** settings to `localStorage` (known secret keys are stripped).
- `ctx.onSettings(handler)` — subscribe to `ctx.setSettings(...)` calls on **this mounted context only**; it does **not** receive external `store` mutations. Returns an unsubscribe function.
- `ctx.getSecret(key)` / `ctx.setSecret(key, value)` / `ctx.deleteSecret(key)` — store API keys, OAuth tokens, and session keys in the OS credential vault (`LumDeck:<uid>:<key>` via Rust) or in-memory session storage in browser preview (never plaintext `localStorage`).
  - `getSecret` returns `null` when unconfigured and **rejects** on vault or migration persistence failure — render a retryable error instead of silently falling back to a connect form.
  - `setSecret` and `deleteSecret` **reject** on failure — await success before updating UI state.
  - Never log secrets, `Bearer` tokens, or tokenized URLs (`sanitizeSecretError` in `src/core/credentials.ts`).
  - When a required credential is unconfigured (and the backend/command is available), render a small "connect" affordance instead of throwing.

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

## Rust command, event & security reference

Call registered commands with `await ctx.invoke("name", { ...args })`. Always handle rejections.

### Registered commands (`src-tauri/src/lib.rs`)

Widget-callable:
- `system_stats() -> { cpu: f32, ram: f32, ram_used_gb: f32, ram_total_gb: f32, battery: u8|null, charging: bool, on_ac: bool, has_battery: bool }`
- `net_connected() -> bool`
- `net_speed() -> { down_bps: u64, up_bps: u64 }` (returns bits/s)
- `open_web_url({ url: string })` — validate and open an external `http:` / `https:` URL without embedded credentials (`userinfo`) or control/NUL chars in the default browser (in browser preview, fall back to validated `window.open(..., "_blank", "noopener")`). Always use this instead of `open_path` for untrusted/upstream URLs.
- `open_path({ path: string })` — launch a user-configured local file, folder, app, or URI via Windows `ShellExecuteW` (never pass untrusted remote URLs).

Framework-only (do not call directly from widgets):
- `dock_position({ edge: "top" | "bottom", heightPx: number })` (`heightPx` in logical CSS px), `taskbar_autohide({ enabled: boolean })`, `quit_app()`
- `cred_set`, `cred_get`, `cred_delete` — managed exclusively by `src/core/credentials.ts`; widgets must use `ctx.getSecret` / `ctx.setSecret` / `ctx.deleteSecret`.

### Unregistered native commands (degraded stubs only)

The following command groups are **NOT registered** in `src-tauri/src/lib.rs` in the current build. Widgets referencing them are degraded entries — keep their existing widget IDs and layouts, classify failures with `classifyIpcUnavailable` (`src/core/tauri.ts`) to distinguish browser preview from an unregistered native build, **stop repeated polling/invocations** once unavailable, and **do not collect new sensitive credentials** while unavailable. Real native implementations require separate requirements and acceptance:
- `volume_get`, `volume_set`, `volume_toggle_mute` (`system/volume.widget.ts`)
- `brightness_get`, `brightness_set` (`system/brightness.widget.ts`)
- `now_playing`, `media_control` (`media/now-playing.widget.ts`)
- `ai_usage` (`ai/ai-usage.widget.ts`)

### Events & capabilities

- Tauri events emitted by `src-tauri/src/lib.rs`: `tray:widgets`, `tray:settings` (subscribed by `src/dock/dock.ts` via `listen()` in `src/core/tauri.ts`, which catches subscription rejections, deduplicates diagnostics without logging credentials/payloads, and guards against post-unsubscribe callbacks).
- Capabilities (`src-tauri/capabilities/default.json`): scoped to `"windows": ["main"]` with `"core:default"`, `"core:window:default"`, `"core:event:default"`, `"core:app:default"`, and `"core:webview:default"`.

### CSP & widget HTTP request boundaries

- Window CSP (`src-tauri/tauri.conf.json`): `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https: ws: wss:; font-src 'self'`.
- Widgets may fetch CORS-friendly `https:` endpoints; plain `http:` requests, remote scripts, and `eval` are blocked by CSP in the packaged WebView.
- Use `fetchJson` or `fetchText` from `src/core/http.ts` with `ctx.signal` to bound both the request and response-body reading. Check `HttpError.kind` and `HttpError.status` when handling failures. Log only the error classification and keep credentials and request URLs out of diagnostics.

## Golden rules

- Self-contained, strict-TypeScript clean. No edits to shared files.
- Never throw uncaught from `refresh`/`mount`; show a small fallback instead.
- Reasonable `defaultSize` and `refreshMs`. Clean up timers in `destroy`.
- After writing, run `cd /d/Code/LumDeck && npx tsc --noEmit` and fix errors in
  your own files only. Do not run `vite build` or `cargo`. Do not add doc files.
