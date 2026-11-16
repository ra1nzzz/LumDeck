# LumDeck

LumDeck is a lightweight Windows desktop dock for live widgets. Choose the widgets you want, arrange them along the top or bottom edge of the screen, and tune the dock's size and appearance.

## Features

- Top or bottom edge placement, with small, medium, and large sizes and five visual styles.
- Add, remove, reorder, and resize widgets; layouts and ordinary settings are saved on this PC.
- Optional taskbar auto-hide with recovery of the previous taskbar settings when LumDeck exits.
- System tray menu for opening the widget picker and settings, or quitting the app.
- HiDPI-aware placement and native Windows Credential Manager storage for provider secrets.
- Built-in widgets for clocks, calendar, notes, to-dos, timers, Pomodoro, battery, system/network stats, app launching, weather, stocks, currency, GitHub, Stack Overflow, Hacker News, Gmail, social profiles, and Stripe revenue.

Provider-backed widgets may require an account, token, or API key. Enter credentials in the relevant widget's settings. Secrets are stored per widget in Windows Credential Manager; they are not included in the layout settings.

## Download and install

When a prebuilt version is published, download `LumDeck_*_x64-setup.exe` from the repository's [Releases](https://github.com/ra1nzzz/LumDeck/releases) page and run it. The project does not have a published release yet; use the build steps below to create an installer. The installer can download the Microsoft WebView2 runtime if it is not already installed, so internet access may be required during installation.

To uninstall, use **Settings → Apps → Installed apps** in Windows.

## Current limitations

The volume, brightness, now-playing/media-control, and AI-usage tiles are present in the picker, but their native Windows commands are not registered in this build, so those controls do not operate yet. Provider APIs can also change their response formats or rate limits; a connected widget may need a valid credential and network access.

## Build from source

### Requirements

- Windows 10 or 11, x64
- Node.js 20 or newer and npm
- Rust with the MSVC target
- Visual Studio Build Tools with the C++ workload and Windows SDK
- Microsoft Edge WebView2 Runtime

### Commands

```powershell
npm ci
npm run app:dev
```

Build the NSIS installer (`.exe`) and app binary:

```powershell
npm run app:build -- --bundles nsis
```

The installer is written to `src-tauri/target/release/bundle/nsis/`. The standalone application binary is written to `src-tauri/target/release/`.

Build both configured installer formats (NSIS and MSI) with:

```powershell
npm run app:build
```

Run the frontend and Rust test suites with `npm test` and `cargo test --locked --manifest-path src-tauri/Cargo.toml`.

## Project structure

- `src/widgets/` — auto-registered widget modules
- `src/core/` — app state, widget context, HTTP helpers, and credential handling
- `src/dock/` and `src/ui/` — dock rendering and settings UI
- `src-tauri/` — Windows integration and Tauri commands
- `docs/WIDGET_AUTHORING.md` — guide to adding a widget
- `docs/reviews/` — review findings and implementation record

LumDeck keeps layout and non-secret settings locally and does not use a LumDeck account or telemetry. Widgets that use online services connect to those services from the app.
