import { sanitizeSecretError } from "../../core/credentials";
import { fetchJson, isAbortError, isHttpError } from "../../core/http";
import type { WidgetModule } from "../../core/types";

const githubIcon =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.23-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>';

const refreshIcon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';

/** Read the `rel="last"` page number from a GitHub Link header, if present. */
export function parseLastPage(link: string | null): number | null {
  if (!link) return null;
  const parts = link.split(/,(?=\s*<)/);
  for (const part of parts) {
    const urlMatch = /^\s*<([^>]+)>([\s\S]*)$/.exec(part);
    if (!urlMatch) continue;
    const [, rawUrl, params] = urlMatch;
    const relMatch = /;\s*rel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;,\s]*))/i.exec(params);
    if (!relMatch) continue;
    const rels = (relMatch[1] ?? relMatch[2] ?? relMatch[3] ?? "").trim().split(/\s+/);
    if (!rels.includes("last")) continue;
    try {
      const parsed = new URL(rawUrl, "https://api.github.com");
      const pageRaw = parsed.searchParams.get("page");
      if (!pageRaw || !/^\d+$/.test(pageRaw)) return null;
      const page = Number(pageRaw);
      return Number.isSafeInteger(page) && page > 0 ? page : null;
    } catch {
      return null;
    }
  }
  return null;
}

const mod: WidgetModule = {
  id: "github-activity",
  name: "GitHub",
  group: "analytics",
  description: "Unread notification count",
  icon: githubIcon,
  defaultSize: { w: 2, h: 1 },
  refreshMs: 120000,
  async mount(body, ctx) {
    let token = "";
    let destroyed = false;
    let saving = false;
    let view: "" | "connect" | "connected" | "vault-error" = "";
    let generation = 0;
    let activeJob: {
      key: string;
      gen: number;
      controller: AbortController;
      promise: Promise<void>;
    } | null = null;
    let authRejected = false;
    let retryUntil = 0;

    const cleanup = () => {
      if (destroyed) return;
      destroyed = true;
      generation++;
      activeJob?.controller.abort();
      activeJob = null;
      ctx.signal?.removeEventListener("abort", cleanup);
    };
    ctx.signal?.addEventListener("abort", cleanup, { once: true });

    const renderConnect = (hint = "") => {
      if (destroyed) return;
      view = "connect";
      body.innerHTML = `
        <div class="w-col" style="gap:5px;height:100%;justify-content:center">
          <div class="w-row" style="gap:6px">
            <span class="w-icon w-accent" style="width:16px;height:16px">${githubIcon}</span>
            <span class="w-title">Connect GitHub</span>
          </div>
          <div class="w-row" style="gap:6px">
            <input data-token type="password" spellcheck="false" autocomplete="off" class="search" style="margin:0;padding:4px 7px;font-size:11px;flex:1;min-width:0" placeholder="Personal access token" />
            <button data-save class="w-btn" style="padding:4px 8px">Save</button>
          </div>
          <div class="w-error" data-err style="font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${hint.replace(/[<>&"']/g, "")}</div>
        </div>`;
      const input = body.querySelector<HTMLInputElement>("[data-token]")!;
      const save = body.querySelector<HTMLButtonElement>("[data-save]")!;
      const errEl = body.querySelector<HTMLElement>("[data-err]")!;
      const doSave = async () => {
        if (saving || destroyed) return;
        const v = input.value.trim();
        if (!v) return;
        saving = true;
        save.disabled = true;
        errEl.textContent = "";
        try {
          await ctx.setSecret("token", v);
        } catch (err) {
          if (!destroyed) {
            errEl.textContent = sanitizeSecretError(err, [v]);
            save.disabled = false;
          }
          saving = false;
          return;
        }
        saving = false;
        if (destroyed) return;
        token = v;
        authRejected = false;
        retryUntil = 0;
        generation++;
        activeJob?.controller.abort();
        activeJob = null;
        route();
      };
      save.addEventListener("click", () => {
        void doSave();
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") void doSave();
      });
    };

    const renderVaultError = (msg: string) => {
      if (destroyed) return;
      view = "vault-error";
      body.innerHTML = `
        <div class="w-col" style="gap:5px;height:100%;justify-content:center">
          <div class="w-row" style="gap:6px">
            <span class="w-icon w-accent" style="width:15px;height:15px">${githubIcon}</span>
            <span class="w-title">Credential vault error</span>
          </div>
          <div class="w-row" style="gap:6px;justify-content:space-between">
            <span class="w-error" data-err style="font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${msg.replace(/[<>&"']/g, "")}</span>
            <button data-retry class="w-btn" style="padding:3px 8px;flex:0 0 auto">Retry</button>
          </div>
        </div>`;
      body.querySelector<HTMLButtonElement>("[data-retry]")!.addEventListener("click", () => {
        void init();
      });
    };

    const renderConnected = () => {
      if (destroyed || view === "connected") return;
      view = "connected";
      body.innerHTML = `
        <div class="w-row" style="justify-content:space-between;height:100%">
          <div class="w-col" style="gap:1px;justify-content:center">
            <div class="w-title">Unread</div>
            <div class="w-big w-mono" data-count>–</div>
            <div class="w-dim" style="font-size:11px" data-login>&nbsp;</div>
          </div>
          <div class="w-row" style="gap:6px">
            <span class="w-icon w-accent" style="width:22px;height:22px">${githubIcon}</span>
            <button data-refresh class="w-btn" style="padding:5px 6px;display:inline-flex" title="Refresh">
              <span class="w-icon" style="width:13px;height:13px">${refreshIcon}</span>
            </button>
          </div>
        </div>`;
      body.querySelector<HTMLButtonElement>("[data-refresh]")!.addEventListener("click", () => {
        void refresh();
      });
    };

    const showData = (count: string, login: string, unread: number) => {
      if (destroyed) return;
      const c = body.querySelector<HTMLElement>("[data-count]");
      const l = body.querySelector<HTMLElement>("[data-login]");
      if (c) {
        c.textContent = count;
        c.classList.toggle("w-good", unread === 0);
        c.classList.toggle("w-accent", unread > 0);
      }
      if (l) l.textContent = login;
    };

    const showFallback = (msg: string) => {
      if (destroyed) return;
      const c = body.querySelector<HTMLElement>("[data-count]");
      const l = body.querySelector<HTMLElement>("[data-login]");
      if (c) {
        c.textContent = "–";
        c.classList.remove("w-good", "w-accent");
      }
      if (l) l.textContent = msg;
    };

    const refresh = (): Promise<void> => {
      if (destroyed) return Promise.resolve();
      const t = token;
      if (!t || authRejected) {
        if (view !== "connect") {
          renderConnect(authRejected ? "Invalid token — paste a new one" : "");
        }
        return Promise.resolve();
      }
      if (view !== "connected") renderConnected();
      if (activeJob && activeJob.key === t) {
        return activeJob.promise;
      }
      if (Date.now() < retryUntil) {
        showFallback("rate limited");
        return Promise.resolve();
      }

      activeJob?.controller.abort();
      const jobGen = ++generation;
      const controller = new AbortController();
      const headers = {
        Authorization: `Bearer ${t}`,
        Accept: "application/vnd.github+json",
      };

      const promise = (async () => {
        try {
          const [userRes, notifRes] = await Promise.all([
            fetchJson<{ login?: unknown }>("https://api.github.com/user", {
              headers,
              signal: controller.signal,
              timeoutMs: 10_000,
              allowNotModified: true,
            }),
            fetchJson<unknown>("https://api.github.com/notifications?per_page=1", {
              headers,
              signal: controller.signal,
              timeoutMs: 10_000,
              allowNotModified: true,
            }),
          ]);
          if (destroyed || jobGen !== generation || controller.signal.aborted) return;
          retryUntil = 0;
          const user = userRes.data ?? {};
          const list = Array.isArray(notifRes.data) ? notifRes.data : [];
          // With per_page=1 the `rel="last"` page number equals the unread total.
          const last = parseLastPage(notifRes.headers.get("Link"));
          const unread = last != null ? last : list.length;
          const login = typeof user.login === "string" && user.login ? user.login : "—";
          showData(String(unread), login, unread);
        } catch (err) {
          if (isAbortError(err)) return;
          if (destroyed || jobGen !== generation || controller.signal.aborted) return;
          controller.abort();
          if (isHttpError(err, "http")) {
            if (err.status === 401) {
              authRejected = true;
              renderConnect("Invalid token — paste a new one");
              return;
            }
            if (err.status === 403) {
              showFallback("auth 403");
              return;
            }
            if (err.status === 429) {
              retryUntil = Date.now() + (err.retryAfterMs ?? 60_000);
              showFallback("rate limited");
              return;
            }
            showFallback(`GitHub ${err.status}`);
            return;
          }
          if (isHttpError(err, "timeout")) {
            showFallback("timeout");
            return;
          }
          if (isHttpError(err, "decode")) {
            showFallback("bad response");
            return;
          }
          showFallback("offline");
        } finally {
          if (activeJob?.gen === jobGen) {
            activeJob = null;
          }
        }
      })();

      activeJob = { key: t, gen: jobGen, controller, promise };
      return promise;
    };

    const route = () => {
      if (destroyed) return;
      if (token && !authRejected) {
        renderConnected();
        void refresh();
      } else {
        renderConnect(authRejected ? "Invalid token — paste a new one" : "");
      }
    };

    const init = async (): Promise<void> => {
      if (destroyed || ctx.signal?.aborted) {
        cleanup();
        return;
      }
      try {
        token = ((await ctx.getSecret("token")) ?? "").trim();
      } catch (err) {
        if (!destroyed) renderVaultError(sanitizeSecretError(err));
        return;
      }
      if (destroyed || ctx.signal?.aborted) {
        cleanup();
        return;
      }
      route();
    };

    await init();

    return {
      refresh,
      destroy: cleanup,
    };
  },
};

export default mod;
