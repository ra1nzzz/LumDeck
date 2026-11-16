// Thin, dependency-light wrapper over the Tauri JS API.
//
// Works both inside the packaged app and in a plain browser (where Tauri is
// absent): there `invoke` rejects, and widgets are expected to handle that.

const hasTauri =
  typeof window !== "undefined" &&
  ("__TAURI__" in window || "__TAURI_INTERNALS__" in window);

type Args = Record<string, unknown>;

export type IpcUnavailableReason = "preview" | "native";

const reportedListenErrors = new Set<string>();

const SAFE_ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "DOMException",
]);

function errorCategory(err: unknown): string {
  if (err instanceof Error) {
    return SAFE_ERROR_NAMES.has(err.name) ? err.name : "Error";
  }
  if (err === null) return "null";
  return typeof err;
}

/** True when running inside the Tauri desktop runtime rather than plain browser preview. */
export function isTauri(): boolean {
  return (
    hasTauri ||
    (typeof window !== "undefined" &&
      ("__TAURI__" in window || "__TAURI_INTERNALS__" in window))
  );
}

/**
 * Classify whether an IPC failure is caused by plain browser preview ("preview")
 * or an unregistered native command ("native"). Returns `null` for other errors.
 */
export function classifyIpcUnavailable(
  err: unknown,
  commands: readonly string[] = [],
): IpcUnavailableReason | null {
  const msg = (err instanceof Error && err.message ? err.message : String(err)).toLowerCase();
  if (msg.includes("tauri unavailable") || msg.includes("called outside the app")) {
    return "preview";
  }
  if (
    msg.includes("not found") ||
    msg.includes("unknown command") ||
    msg.includes("not registered") ||
    commands.some((cmd) => msg.includes(cmd.toLowerCase()))
  ) {
    return "native";
  }
  return null;
}

export async function invoke<T = unknown>(cmd: string, args?: Args): Promise<T> {
  if (!isTauri()) {
    throw new Error(`Tauri unavailable (command "${cmd}" called outside the app)`);
  }
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

let eventModulePromise: Promise<typeof import("@tauri-apps/api/event")> | null = null;

function loadEventModule(): Promise<typeof import("@tauri-apps/api/event")> {
  if (!eventModulePromise) {
    eventModulePromise = import("@tauri-apps/api/event").catch((err) => {
      eventModulePromise = null;
      throw err;
    });
  }
  return eventModulePromise;
}

export function listen<T = unknown>(
  event: string,
  handler: (payload: T) => void,
): () => void {
  if (!isTauri()) return () => {};
  let un: (() => void) | undefined;
  let alive = true;
  void loadEventModule()
    .then(({ listen: tauriListen }) => {
      if (!alive) return undefined;
      return tauriListen<T>(event, (e) => {
        if (!alive) return;
        handler(e.payload);
      });
    })
    .then((fn) => {
      if (!fn) return;
      if (alive) {
        un = fn;
      } else {
        try {
          fn();
        } catch {
          /* ignore late unlisten error after unsubscribe */
        }
      }
    })
    .catch((err) => {
      if (!alive) return;
      const category = errorCategory(err);
      const dedupeKey = `listen:${event}:${category}`;
      if (!reportedListenErrors.has(dedupeKey)) {
        if (reportedListenErrors.size < 64) {
          reportedListenErrors.add(dedupeKey);
        }
        console.warn("[lumdeck] tauri.listen failed", { op: "listen", event, category });
      }
    });
  return () => {
    alive = false;
    const fn = un;
    un = undefined;
    if (fn) {
      try {
        fn();
      } catch {
        /* ignore unlisten error */
      }
    }
  };
}

export { hasTauri };
