import { sanitizeSecretError } from "../../core/credentials";
import { fetchJson, isAbortError, isHttpError } from "../../core/http";
import type { WidgetModule } from "../../core/types";

const igIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="1.2" fill="currentColor" stroke="none"/></svg>`;

const linkIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07L11 4.93"/><path d="M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 0 0 7.07 7.07L13 19.07"/></svg>`;

interface IgProfile {
  followers_count?: number;
  username?: string;
}

const asString = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const compact = (n: number): string => {
  if (!Number.isFinite(n) || n < 0) return "–";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return String(Math.round(n));
};

const mod: WidgetModule = {
  id: "instagram-followers",
  name: "Instagram",
  group: "social",
  description: "Follower count via the Instagram Graph API",
  icon: igIcon,
  defaultSize: { w: 2, h: 1 },
  refreshMs: 300000,
  async mount(body, ctx) {
    let accessToken = "";
    let userId = asString(ctx.settings.userId);
    let username = "";
    let rejected = false;
    let destroyed = false;
    let secretOp = false;
    let view: "" | "main" | "connect" | "vault-error" = "";
    let generation = 0;
    let activeJob: {
      key: string;
      gen: number;
      controller: AbortController;
      promise: Promise<void>;
    } | null = null;
    let retryUntil = 0;

    const q = <T extends HTMLElement>(sel: string): T => body.querySelector<T>(sel)!;

    const profileUrl = (token: string, targetUser: string): string => {
      const target = targetUser ? encodeURIComponent(targetUser) : "me";
      return `https://graph.instagram.com/${target}?fields=followers_count,username&access_token=${encodeURIComponent(token)}`;
    };

    const mainView = () => `
      <div class="w-row" style="justify-content:space-between;height:100%;gap:4px">
        <div class="w-col" style="gap:1px;min-width:0">
          <div class="w-row" style="gap:5px;min-width:0">
            <span data-user class="w-dim" style="font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
            <span data-note class="w-faint" style="font-size:9px"></span>
          </div>
          <div class="w-big w-mono" data-count>–</div>
          <div class="w-dim" style="font-size:10px">followers</div>
        </div>
        <div class="w-col" style="align-items:center;gap:5px;flex:0 0 auto">
          <div class="w-icon w-accent" style="width:22px;height:22px">${igIcon}</div>
          <div class="w-row" style="gap:4px;flex:0 0 auto">
            <button class="w-btn" data-refresh style="padding:2px 6px;background:transparent;color:var(--text-faint)" title="Refresh">↻</button>
            <button class="w-btn" data-key style="padding:2px 5px;background:transparent;color:var(--text-faint)" title="Change token"><span class="w-icon" style="width:12px;height:12px">${linkIcon}</span></button>
          </div>
        </div>
      </div>`;

    const connectView = (hint: string) => `
      <div class="w-col" style="gap:4px;height:100%;justify-content:center">
        <div class="w-row w-title" style="gap:5px">
          <span class="w-icon w-accent" style="width:13px;height:13px">${igIcon}</span>
          <span>Connect Instagram</span>
        </div>
        <input data-token class="search" style="margin:0;padding:3px 6px;font-size:11px" type="password" spellcheck="false" autocomplete="off"
          placeholder="Access token" title="graph.instagram.com access token" />
        <div class="w-row" style="gap:5px">
          <input data-user-input class="search" style="margin:0;padding:3px 6px;font-size:11px;flex:1;min-width:0" placeholder="User ID (optional)" />
          <button class="w-btn" data-save style="padding:3px 10px;font-size:11px;flex:0 0 auto">Connect</button>
        </div>
        <div class="w-error" data-err style="font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${hint.replace(/[<>&"']/g, "")}</div>
      </div>`;

    const showUser = () => {
      if (destroyed) return;
      const el = body.querySelector<HTMLElement>("[data-user]");
      if (el) el.textContent = username ? `@${username}` : userId ? `#${userId}` : "Instagram";
    };

    const setNote = (text: string) => {
      if (destroyed) return;
      const el = body.querySelector<HTMLElement>("[data-note]");
      if (el) el.textContent = text;
    };

    const setCount = (text: string, title: string) => {
      if (destroyed) return;
      const el = body.querySelector<HTMLElement>("[data-count]");
      if (el) {
        el.textContent = text;
        el.title = title;
      }
    };

    const showMain = () => {
      if (destroyed) return;
      view = "main";
      body.innerHTML = mainView();
      showUser();
      setCount("–", "");
      setNote("");
      q<HTMLButtonElement>("[data-refresh]").addEventListener("click", () => void refresh());
      const keyBtn = q<HTMLButtonElement>("[data-key]");
      keyBtn.addEventListener("click", () => {
        if (secretOp || destroyed) return;
        secretOp = true;
        keyBtn.disabled = true;
        void (async () => {
          try {
            await ctx.deleteSecret("accessToken");
          } catch (err) {
            if (!destroyed) {
              setNote("clear failed");
              keyBtn.title = sanitizeSecretError(err, [accessToken]);
              keyBtn.disabled = false;
            }
            secretOp = false;
            return;
          }
          secretOp = false;
          if (destroyed) return;
          accessToken = "";
          username = "";
          rejected = false;
          retryUntil = 0;
          generation++;
          activeJob?.controller.abort();
          activeJob = null;
          showConnect("");
        })();
      });
    };

    const showConnect = (hint: string) => {
      if (destroyed) return;
      view = "connect";
      body.innerHTML = connectView(hint);
      const tokenInput = q<HTMLInputElement>("[data-token]");
      const userInput = q<HTMLInputElement>("[data-user-input]");
      const saveBtn = q<HTMLButtonElement>("[data-save]");
      const errEl = q<HTMLElement>("[data-err]");
      if (userId) userInput.value = userId;
      const save = async () => {
        if (secretOp || destroyed) return;
        const nextToken = tokenInput.value.trim();
        const nextUser = userInput.value.trim();
        if (!nextToken) return;
        secretOp = true;
        saveBtn.disabled = true;
        errEl.textContent = "";
        try {
          await ctx.setSecret("accessToken", nextToken);
        } catch (err) {
          if (!destroyed) {
            errEl.textContent = sanitizeSecretError(err, [nextToken]);
            saveBtn.disabled = false;
          }
          secretOp = false;
          return;
        }
        secretOp = false;
        if (destroyed) return;
        accessToken = nextToken;
        if (nextUser !== userId) {
          userId = nextUser;
          username = "";
          ctx.setSettings({ userId: nextUser });
        }
        rejected = false;
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
      tokenInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") void save();
      });
      userInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") void save();
      });
    };

    const showVaultError = (msg: string) => {
      if (destroyed) return;
      view = "vault-error";
      body.innerHTML = `
        <div class="w-col" style="gap:5px;height:100%;justify-content:center">
          <div class="w-row w-title" style="gap:5px">
            <span class="w-icon w-accent" style="width:13px;height:13px">${igIcon}</span>
            <span>Credential vault error</span>
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

    const refresh = (): Promise<void> => {
      if (destroyed) return Promise.resolve();
      const targetToken = accessToken;
      const targetUser = userId;
      if (!targetToken || rejected) {
        if (view !== "connect") {
          showConnect(rejected ? "Token rejected — paste a new one" : "");
        }
        return Promise.resolve();
      }
      if (view !== "main") showMain();

      const key = `${targetToken}\0${targetUser}`;
      if (activeJob && activeJob.key === key) {
        return activeJob.promise;
      }

      if (Date.now() < retryUntil) {
        setCount("–", "");
        setNote("rate limited");
        return Promise.resolve();
      }

      activeJob?.controller.abort();
      const jobGen = ++generation;
      const controller = new AbortController();

      const promise = (async () => {
        try {
          const res = await fetchJson<IgProfile>(profileUrl(targetToken, targetUser), {
            signal: controller.signal,
            timeoutMs: 8000,
            allowNotModified: true,
          });
          if (destroyed || jobGen !== generation || controller.signal.aborted) return;
          retryUntil = 0;
          if (res.noContent || !res.data) {
            if (res.status === 304) return;
            setCount("–", "");
            setNote("limited");
            return;
          }
          const data = res.data;
          const followers =
            typeof data.followers_count === "number" && Number.isFinite(data.followers_count)
              ? data.followers_count
              : null;
          if (followers === null) {
            setCount("–", "");
            setNote("limited");
            return;
          }
          if (typeof data.username === "string" && data.username.trim()) {
            username = data.username.trim();
            showUser();
          }
          setCount(compact(followers), followers.toLocaleString());
          setNote("");
        } catch (err) {
          if (isAbortError(err)) return;
          if (destroyed || jobGen !== generation || controller.signal.aborted) return;
          if (isHttpError(err, "http")) {
            if (err.status === 400 || err.status === 401 || err.status === 403) {
              rejected = true;
              showConnect("Token rejected — paste a new one");
              return;
            }
            if (err.status === 429) {
              retryUntil = Date.now() + (err.retryAfterMs ?? 60_000);
              setCount("–", "");
              setNote("rate limited");
              return;
            }
            setCount("–", "");
            setNote(`HTTP ${err.status}`);
            return;
          }
          if (isHttpError(err, "timeout")) {
            setCount("–", "");
            setNote("timeout");
            return;
          }
          if (isHttpError(err, "decode")) {
            setCount("–", "");
            setNote("bad response");
            return;
          }
          setCount("–", "");
          setNote("offline");
        } finally {
          if (activeJob?.gen === jobGen) {
            activeJob = null;
          }
        }
      })();

      activeJob = { key, gen: jobGen, controller, promise };
      return promise;
    };

    const offSettings = ctx.onSettings((s) => {
      if (destroyed) return;
      const nextUser = asString(s.userId);
      if (nextUser === userId) return;
      userId = nextUser;
      username = "";
      generation++;
      activeJob?.controller.abort();
      activeJob = null;
      retryUntil = 0;
      if (view === "main") {
        showUser();
        setCount("–", "");
        setNote("");
      } else {
        const userInput = body.querySelector<HTMLInputElement>("[data-user-input]");
        if (userInput && document.activeElement !== userInput) {
          userInput.value = userId;
        }
      }
      if (accessToken && !rejected) void refresh();
    });

    const cleanup = () => {
      if (destroyed) return;
      destroyed = true;
      generation++;
      activeJob?.controller.abort();
      activeJob = null;
      offSettings();
      ctx.signal?.removeEventListener("abort", cleanup);
    };
    ctx.signal?.addEventListener("abort", cleanup, { once: true });

    const init = async (): Promise<void> => {
      if (destroyed || ctx.signal?.aborted) {
        cleanup();
        return;
      }
      try {
        accessToken = ((await ctx.getSecret("accessToken")) ?? "").trim();
      } catch (err) {
        if (!destroyed) showVaultError(sanitizeSecretError(err));
        return;
      }
      if (destroyed || ctx.signal?.aborted) {
        cleanup();
        return;
      }
      if (accessToken) {
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
