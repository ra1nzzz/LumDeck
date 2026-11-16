import { sanitizeSecretError } from "../../core/credentials";
import { fetchJson, isAbortError, isHttpError } from "../../core/http";
import type { WidgetModule } from "../../core/types";
import { icons } from "../icons";

interface GmailLabel {
  messagesUnread?: number;
}

const LABELS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/labels/INBOX";

const mod: WidgetModule = {
  id: "gmail-unread",
  name: "Gmail",
  group: "online",
  description: "Unread inbox count (OAuth token, read-only)",
  icon: icons.mail,
  defaultSize: { w: 2, h: 1 },
  refreshMs: 120000,
  async mount(body, ctx) {
    let token = "";
    let destroyed = false;
    let saving = false;

    const mainHtml = `
      <div class="w-row" style="justify-content:space-between;height:100%;gap:4px">
        <div class="w-col" style="min-width:0">
          <div class="w-big w-mono" data-count>–</div>
          <div class="w-dim" style="font-size:11px" data-label>inbox</div>
        </div>
        <div class="w-row" style="gap:4px;flex:0 0 auto">
          <button class="w-btn" data-refresh title="Refresh">↻</button>
          <div class="w-icon w-accent" style="width:20px;height:20px">${icons.mail}</div>
        </div>
      </div>`;

    const connectHtml = (hint: string) => `
      <div class="w-col" style="gap:5px;height:100%;justify-content:center">
        <div class="w-row" style="gap:6px">
          <div class="w-icon w-accent" style="width:15px;height:15px">${icons.mail}</div>
          <span class="w-title">Connect Gmail</span>
        </div>
        <div class="w-row" style="gap:5px">
          <input data-token type="password" spellcheck="false" autocomplete="off" class="search" style="margin:0;padding:4px 7px;font-size:11px;flex:1;min-width:0"
            placeholder="Paste access token (gmail.readonly)" />
          <button class="w-btn" data-save style="padding:4px 8px;flex:0 0 auto">Save</button>
        </div>
        <div class="w-error" data-err style="font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${hint.replace(/[<>&"']/g, "")}</div>
      </div>`;

    let view: "" | "main" | "connect" | "vault-error" = "";
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

    const showMain = () => {
      if (destroyed || view === "main") return;
      view = "main";
      body.innerHTML = mainHtml;
      body.querySelector<HTMLButtonElement>("[data-refresh]")!.addEventListener("click", () => {
        void refresh();
      });
    };

    const showConnect = (hint: string) => {
      if (destroyed) return;
      view = "connect";
      body.innerHTML = connectHtml(hint);
      const input = body.querySelector<HTMLInputElement>("[data-token]")!;
      const saveBtn = body.querySelector<HTMLButtonElement>("[data-save]")!;
      const errEl = body.querySelector<HTMLElement>("[data-err]")!;
      const save = async () => {
        if (saving || destroyed) return;
        const value = input.value.trim();
        if (!value) return;
        saving = true;
        saveBtn.disabled = true;
        errEl.textContent = "";
        try {
          await ctx.setSecret("accessToken", value);
        } catch (err) {
          if (!destroyed) {
            errEl.textContent = sanitizeSecretError(err, [value]);
            saveBtn.disabled = false;
          }
          saving = false;
          return;
        }
        saving = false;
        if (destroyed) return;
        token = value;
        authRejected = false;
        retryUntil = 0;
        generation++;
        activeJob?.controller.abort();
        activeJob = null;
        showMain();
        void refresh();
      };
      saveBtn.addEventListener("click", () => {
        void save();
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") void save();
      });
    };

    const showVaultError = (msg: string) => {
      if (destroyed) return;
      view = "vault-error";
      body.innerHTML = `
        <div class="w-col" style="gap:5px;height:100%;justify-content:center">
          <div class="w-row" style="gap:6px">
            <div class="w-icon w-accent" style="width:15px;height:15px">${icons.mail}</div>
            <span class="w-title">Credential vault error</span>
          </div>
          <div class="w-row" style="gap:6px;justify-content:space-between">
            <span class="w-error" data-err style="font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${msg.replace(/[<>&"']/g, "")}</span>
            <button class="w-btn" data-retry style="padding:3px 8px;flex:0 0 auto">Retry</button>
          </div>
        </div>`;
      body.querySelector<HTMLButtonElement>("[data-retry]")!.addEventListener("click", () => {
        void init();
      });
    };

    const setCount = (text: string, label: string) => {
      if (destroyed) return;
      const c = body.querySelector<HTMLElement>("[data-count]");
      const l = body.querySelector<HTMLElement>("[data-label]");
      if (c) c.textContent = text;
      if (l) l.textContent = label;
    };

    const refresh = (): Promise<void> => {
      if (destroyed) return Promise.resolve();
      const t = token;
      if (!t || authRejected) {
        if (view !== "connect") {
          showConnect(authRejected ? "Token expired — paste a new one" : "");
        }
        return Promise.resolve();
      }
      if (view !== "main") showMain();
      if (activeJob && activeJob.key === t) {
        return activeJob.promise;
      }
      if (Date.now() < retryUntil) {
        setCount("–", "rate limited");
        return Promise.resolve();
      }

      activeJob?.controller.abort();
      const jobGen = ++generation;
      const controller = new AbortController();
      setCount("…", "inbox");

      const promise = (async () => {
        try {
          const res = await fetchJson<GmailLabel>(LABELS_URL, {
            headers: { Authorization: `Bearer ${t}` },
            signal: controller.signal,
            timeoutMs: 10_000,
            allowNotModified: true,
          });
          if (destroyed || jobGen !== generation || controller.signal.aborted) return;
          retryUntil = 0;
          if (res.noContent || !res.data) {
            setCount("–", "inbox");
            return;
          }
          const unread = typeof res.data.messagesUnread === "number" ? res.data.messagesUnread : 0;
          setCount(String(unread), "inbox");
        } catch (err) {
          if (isAbortError(err)) return;
          if (destroyed || jobGen !== generation || controller.signal.aborted) return;
          if (isHttpError(err, "http")) {
            if (err.status === 401) {
              authRejected = true;
              showConnect("Token expired — paste a new one");
              return;
            }
            if (err.status === 403) {
              setCount("–", "auth 403");
              return;
            }
            if (err.status === 429) {
              retryUntil = Date.now() + (err.retryAfterMs ?? 60_000);
              setCount("–", "rate limited");
              return;
            }
            setCount("–", `HTTP ${err.status}`);
            return;
          }
          if (isHttpError(err, "timeout")) {
            setCount("–", "timeout");
            return;
          }
          setCount("–", "inbox");
        } finally {
          if (activeJob?.gen === jobGen) {
            activeJob = null;
          }
        }
      })();

      activeJob = { key: t, gen: jobGen, controller, promise };
      return promise;
    };

    const init = async (): Promise<void> => {
      if (destroyed || ctx.signal?.aborted) {
        cleanup();
        return;
      }
      try {
        token = ((await ctx.getSecret("accessToken")) ?? "").trim();
      } catch (err) {
        if (!destroyed) showVaultError(sanitizeSecretError(err));
        return;
      }
      if (destroyed || ctx.signal?.aborted) {
        cleanup();
        return;
      }
      if (token) {
        showMain();
        void refresh();
      } else {
        showConnect("");
      }
    };

    await init();

    return {
      refresh,
      destroy: cleanup,
    };
  },
};

export default mod;
