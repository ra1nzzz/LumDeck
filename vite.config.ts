import { defineConfig } from "vite";

// Tauri serves the built frontend over a custom protocol in production and
// over a dev server in development. Keep the dev server on a fixed port so
// tauri.conf.json can point at it.
export default defineConfig({
  server: {
    port: 5183,
    strictPort: true,
  },
  build: {
    target: "esnext",
    // Tauri embeds the built assets; keep sourcemaps off for smaller bundles.
    sourcemap: false,
  },
});
