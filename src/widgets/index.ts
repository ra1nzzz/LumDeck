// Auto-registers every widget. Convention: each widget lives in
// `src/widgets/<group>/<name>.widget.ts` and default-exports a WidgetModule.
// Dropping a new file here is all that's needed — no edits to this file.
import { registry } from "../core/registry";
import type { WidgetModule } from "../core/types";

const modules = import.meta.glob<{ default: WidgetModule }>("./**/*.widget.ts", {
  eager: true,
});

let count = 0;
for (const path in modules) {
  const mod = modules[path].default;
  if (mod && typeof mod.id === "string" && typeof mod.mount === "function") {
    registry.register(mod);
    count++;
  } else {
    console.warn(`[widgets] ${path} did not export a valid WidgetModule`);
  }
}
console.log(`[widgets] registered ${count} widget(s)`);
