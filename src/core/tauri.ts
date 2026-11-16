// Thin, dependency-light wrapper over the Tauri JS API.
//
// Works both inside the packaged app and in a plain browser (where Tauri is
// absent): there `invoke` rejects, and widgets are expected to handle that.

const hasTauri =
  typeof window !== "undefined" &&
  ("__TAURI__" in window || "__TAURI_INTERNALS__" in window);

type Args = Record<string, unknown>;

export async function invoke<T = unknown>(cmd: string, args?: Args): Promise<T> {
  if (!hasTauri) {
    throw new Error(`Tauri unavailable (command "${cmd}" called outside the app)`);
  }
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

export function listen<T = unknown>(
  event: string,
  handler: (payload: T) => void,
): () => void {
  if (!hasTauri) return () => {};
  let un: (() => void) | undefined;
  let alive = true;
  import("@tauri-apps/api/event").then(({ listen: tauriListen }) => {
    if (!alive) return;
    tauriListen<T>(event, (e) => handler(e.payload)).then((fn) => {
      if (alive) un = fn;
      else fn();
    });
  });
  return () => {
    alive = false;
    un?.();
  };
}

export { hasTauri };
