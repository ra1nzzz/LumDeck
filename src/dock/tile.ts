import {
  SecretVaultError,
  createCredentialManager,
  getWidgetSecretMappings,
  sanitizeSecretError,
  stripSecretSettings,
} from "../core/credentials";
import { registry } from "../core/registry";
import { store, storeCredentialPort, type PlacedWidget } from "../core/store";
import { invoke } from "../core/tauri";
import type { SettingsBag, WidgetContext, WidgetInstance } from "../core/types";

export const credentials = createCredentialManager({ store: storeCredentialPort });

/** Build the DOM for one placed widget and mount its module into the body. */
export function renderTile(placed: PlacedWidget): HTMLElement {
  const mod = registry.get(placed.widgetId);

  const tile = document.createElement("div");
  tile.className = "tile no-drag";
  tile.dataset.uid = placed.uid;
  tile.dataset.widget = placed.widgetId;
  tile.style.setProperty("--w", String(placed.size.w));

  const body = document.createElement("div");
  body.className = "tile-body";
  tile.appendChild(body);

  const remove = document.createElement("button");
  remove.className = "tile-remove";
  remove.type = "button";
  remove.textContent = "×";
  remove.title = "Remove";
  tile.appendChild(remove);

  const grip = document.createElement("div");
  grip.className = "tile-grip";
  grip.title = "Drag to reorder";
  tile.appendChild(grip);

  let disposed = false;
  let removing = false;
  let removed = false;
  let errorBanner: HTMLElement | null = null;

  const setTileError = (msg: string | null) => {
    if (disposed) return;
    if (!msg) {
      errorBanner?.remove();
      errorBanner = null;
      remove.title = "Remove";
      return;
    }
    if (!errorBanner) {
      errorBanner = document.createElement("div");
      errorBanner.dataset.tileError = "";
      errorBanner.setAttribute("role", "alert");
      errorBanner.style.cssText =
        "position:absolute;inset:auto 4px 3px 4px;padding:2px 5px;border-radius:6px;background:rgba(180,35,35,0.92);color:#fff;font-size:9px;line-height:1.2;z-index:4;pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
      tile.appendChild(errorBanner);
    }
    errorBanner.textContent = msg;
    remove.title = msg;
  };

  remove.addEventListener("click", (e) => {
    e.stopPropagation();
    if (removing || disposed) return;
    removing = true;
    remove.disabled = true;
    setTileError(null);

    void (async () => {
      const hasSecrets = getWidgetSecretMappings(placed.widgetId).length > 0;
      if (hasSecrets) {
        try {
          await credentials.deleteWidgetSecrets(placed.uid, placed.widgetId);
        } catch {
          if (!disposed) {
            setTileError("Vault delete failed — retry ×");
            removing = false;
            remove.disabled = false;
          }
          return;
        }
      }

      const persisted = store.removeWidget(placed.uid);
      if (!persisted.ok) {
        if (!disposed) {
          setTileError(
            hasSecrets
              ? "Secret cleared; layout save failed — retry ×"
              : "Layout save failed — retry ×",
          );
          removing = false;
          remove.disabled = false;
        }
        return;
      }

      removed = true;
      if (!disposed) {
        removing = false;
        remove.disabled = false;
      }
    })();
  });

  if (!mod) {
    body.innerHTML = `<div class="w-error">missing<br>${escapeHtml(placed.widgetId)}</div>`;
    (tile as unknown as { __destroy?: () => void }).__destroy = () => {
      disposed = true;
    };
    return tile;
  }

  // Initialize cancellable lifecycle before scheduling mount so synchronous
  // unmount before the microtask prevents mount() from ever running.
  const mountAbort = new AbortController();
  const settings: SettingsBag = stripSecretSettings(placed.widgetId, placed.settings);
  const subs = new Set<(s: SettingsBag) => void>();
  const secretHandle = credentials.forWidget(placed.uid, placed.widgetId);
  const ctx: WidgetContext = {
    invoke,
    uid: placed.uid,
    signal: mountAbort.signal,
    settings,
    setSettings: (patch) => {
      const cleanPatch = stripSecretSettings(placed.widgetId, patch);
      Object.assign(settings, cleanPatch);
      const snapshot = { ...settings };
      store.setWidgetSettings(placed.uid, snapshot);
      for (const h of subs) h(snapshot);
    },
    setSecret: (key, value) => {
      if (disposed || removing || removed) {
        return Promise.reject(
          new SecretVaultError("widget_deleted", "Cannot save credential for a removed widget"),
        );
      }
      return secretHandle.setSecret(key, value);
    },
    getSecret: (key) => secretHandle.getSecret(key),
    deleteSecret: (key) => secretHandle.deleteSecret(key),
    onSettings: (h) => {
      subs.add(h);
      return () => subs.delete(h);
    },
  };

  let instance: WidgetInstance | undefined;
  let timer = 0;
  let instanceDestroyed = false;

  const destroyInstanceOnce = (inst: WidgetInstance | undefined): void => {
    if (!inst || instanceDestroyed) return;
    instanceDestroyed = true;
    try {
      inst.destroy?.();
    } catch {
      /* ignore */
    }
  };

  const scheduleNextRefresh = (): void => {
    if (disposed || mountAbort.signal.aborted) return;
    if (!mod.refreshMs || mod.refreshMs <= 0 || !instance?.refresh) return;
    timer = window.setTimeout(async () => {
      timer = 0;
      if (disposed || mountAbort.signal.aborted) return;
      try {
        await instance?.refresh?.();
      } catch {
        /* a throwing refresh must not kill the refresh loop */
      } finally {
        scheduleNextRefresh();
      }
    }, mod.refreshMs);
  };

  Promise.resolve()
    .then(() => {
      if (disposed || mountAbort.signal.aborted) return undefined;
      return mod.mount(body, ctx);
    })
    .then((inst) => {
      if (!inst) return;
      // A layout change may have destroyed this tile while mount() was still
      // pending; tear the late instance down once and never start a timer.
      if (disposed || mountAbort.signal.aborted) {
        destroyInstanceOnce(inst);
        return;
      }
      instance = inst;
      scheduleNextRefresh();
    })
    .catch((err) => {
      if (disposed || mountAbort.signal.aborted) return;
      console.error(`[widget:${mod.id}] mount failed`, sanitizeSecretError(err));
      body.innerHTML = `<div class="w-error">failed to load</div>`;
    });

  // Cleanup hook used by the dock on structural re-render.
  // Temporary unmount or reorder never deletes Vault credentials.
  (tile as unknown as { __destroy?: () => void }).__destroy = () => {
    if (disposed) return;
    disposed = true;
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
    mountAbort.abort();
    destroyInstanceOnce(instance);
  };

  return tile;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}
