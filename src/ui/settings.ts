import { store, type DockSize, type DockStyle } from "../core/store";
import { hasTauri as moduleHasTauri, invoke } from "../core/tauri";

let isOpen = false;

function isTauriRuntime(): boolean {
  if (moduleHasTauri === true) return true;
  if (
    typeof window !== "undefined" &&
    ("__TAURI__" in window || "__TAURI_INTERNALS__" in window)
  ) {
    return true;
  }
  // Support partial test mocks of core/tauri that export invoke without hasTauri.
  return moduleHasTauri === undefined;
}

function formatTaskbarError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const trimmed = raw.trim();
  if (!trimmed) return "Failed to update taskbar auto-hide.";
  return trimmed.length > 96 ? `${trimmed.slice(0, 93)}...` : trimmed;
}

const STYLES: { id: DockStyle; label: string }[] = [
  { id: "liquid", label: "Liquid Glass" },
  { id: "ios", label: "iOS Glass" },
  { id: "midnight", label: "Midnight" },
  { id: "black", label: "Black" },
  { id: "white", label: "White" },
];
const SIZES: { id: DockSize; label: string }[] = [
  { id: "sm", label: "Small" },
  { id: "md", label: "Medium" },
  { id: "lg", label: "Large" },
];

export function openSettings(): void {
  if (isOpen) return;
  isOpen = true;

  const overlay = document.createElement("div");
  overlay.className = "overlay no-drag";
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.style.cssText = "width:min(520px,92vw);height:auto;flex-direction:column;position:relative;padding:22px 24px;";

  const closeBtn = document.createElement("button");
  closeBtn.className = "panel-close";
  closeBtn.type = "button";
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", close);
  panel.appendChild(closeBtn);

  const title = document.createElement("h2");
  title.textContent = "Settings";
  panel.appendChild(title);

  function section(label: string): HTMLElement {
    const h = document.createElement("h3");
    h.textContent = label;
    panel.appendChild(h);
    return panel;
  }

  // Style
  section("Appearance");
  const styleRow = row(panel, "Style");
  const previews = document.createElement("div");
  previews.className = "style-preview";
  for (const s of STYLES) {
    const p = document.createElement("div");
    p.className = "sp" + (store.get().style === s.id ? " active" : "");
    p.dataset.s = s.id;
    p.textContent = s.label;
    p.addEventListener("click", () => {
      store.setPrefs({ style: s.id });
      previews.querySelectorAll(".sp").forEach((n) => n.classList.remove("active"));
      p.classList.add("active");
    });
    previews.appendChild(p);
  }
  styleRow.appendChild(previews);

  // Size
  const sizeRow = row(panel, "Size");
  const sizeSeg = seg(
    SIZES.map((s) => ({ label: s.label, active: store.get().size === s.id, onClick: () => store.setPrefs({ size: s.id }) })),
  );
  sizeRow.appendChild(sizeSeg);

  // Edge
  const edgeRow = row(panel, "Screen edge");
  const edgeSeg = seg([
    { label: "Top", active: store.get().edge === "top", onClick: () => store.setPrefs({ edge: "top" }) },
    { label: "Bottom", active: store.get().edge === "bottom", onClick: () => store.setPrefs({ edge: "bottom" }) },
  ]);
  edgeRow.appendChild(edgeSeg);

  // Auto-hide taskbar
  const hideRow = row(panel, "Auto-hide taskbar", "Let LumDeck own the edge while it runs.");
  const hideErr = document.createElement("div");
  hideErr.className = "sub w-bad";
  hideErr.dataset.taskbarError = "";
  hideErr.setAttribute("role", "alert");
  hideErr.style.display = "none";
  hideRow.firstElementChild?.appendChild(hideErr);

  const setHideError = (msg: string | null) => {
    if (!msg) {
      hideErr.textContent = "";
      hideErr.style.display = "none";
      return;
    }
    hideErr.textContent = msg;
    hideErr.style.display = "";
  };

  const sw = document.createElement("button");
  sw.type = "button";
  sw.className = "switch" + (store.get().autoHideTaskbar ? " on" : "");
  let taskbarPending = false;
  sw.addEventListener("click", () => {
    if (taskbarPending) return;
    const prev = store.get().autoHideTaskbar;
    const next = !prev;
    taskbarPending = true;
    sw.disabled = true;
    setHideError(null);

    void (async () => {
      try {
        if (isTauriRuntime()) {
          await invoke("taskbar_autohide", { enabled: next });
        }
        store.setPrefs({ autoHideTaskbar: next });
        sw.classList.toggle("on", next);
      } catch (err) {
        sw.classList.toggle("on", prev);
        setHideError(formatTaskbarError(err));
      } finally {
        taskbarPending = false;
        sw.disabled = false;
      }
    })();
  });
  hideRow.appendChild(sw);

  // About
  section("About");
  const about = document.createElement("div");
  about.className = "w-dim";
  about.style.fontSize = "12px";
  about.innerHTML =
    "LumDeck is a clean-room, open reimplementation of the live widget-dock concept. " +
    "It keeps your layout and data on this PC — no account, no server, no telemetry.";
  panel.appendChild(about);

  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) close();
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  window.addEventListener("keydown", onKey);

  function close(): void {
    window.removeEventListener("keydown", onKey);
    overlay.remove();
    isOpen = false;
  }

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}

function row(panel: HTMLElement, label: string, sub?: string): HTMLElement {
  const r = document.createElement("div");
  r.className = "setrow";
  const l = document.createElement("div");
  l.innerHTML = `<div class="lbl">${label}</div>${sub ? `<div class="sub">${sub}</div>` : ""}`;
  r.appendChild(l);
  panel.appendChild(r);
  return r;
}

function seg(items: { label: string; active: boolean; onClick: () => void }[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "seg";
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = it.label;
    if (it.active) b.classList.add("active");
    b.addEventListener("click", () => {
      wrap.querySelectorAll("button").forEach((n) => n.classList.remove("active"));
      b.classList.add("active");
      it.onClick();
    });
    wrap.appendChild(b);
  }
  return wrap;
}
