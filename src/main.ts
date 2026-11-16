import "./styles/glass.css";
import "./widgets";
import { boot } from "./dock/dock";

// Seed a friendly default layout on very first run so the dock isn't empty.
import { store, newUid } from "./core/store";
import { registry } from "./core/registry";

if (store.get().layout.length === 0 && !localStorage.getItem("lumdeck.seeded")) {
  const seed = ["clock-digital", "system-stats", "todo-list"];
  const layout = seed
    .map((id) => registry.get(id))
    .filter((m): m is NonNullable<typeof m> => !!m)
    .map((m) => ({ uid: newUid(m.id), widgetId: m.id, size: { ...m.defaultSize }, settings: {} }));
  if (layout.length) {
    store.setLayout(layout);
    localStorage.setItem("lumdeck.seeded", "1");
  }
}

boot();
