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

/** fetch that never hangs: the Graph API may be unreachable from the webview. */
const fetchWithTimeout = async (url: string, ms: number): Promise<Response> => {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    window.clearTimeout(timer);
  }
};

const mod: WidgetModule = {
  id: "instagram-followers",
  name: "Instagram",
  group: "social",
  description: "Follower count via the Instagram Graph API",
  icon: igIcon,
  defaultSize: { w: 2, h: 1 },
  refreshMs: 300000,
  mount(body, ctx) {
    let accessToken = asString(ctx.settings.accessToken);
    let userId = asString(ctx.settings.userId);
    let username = "";
    let rejected = false;
    let loading = false;
    let view: "main" | "connect" = accessToken ? "main" : "connect";

    const q = <T extends HTMLElement>(sel: string): T => body.querySelector<T>(sel)!;

    const profileUrl = (token: string): string => {
      const target = userId
        ? encodeURIComponent(userId)
        : "me";
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
        <input data-token class="search" style="margin:0;padding:3px 6px;font-size:11px" type="password"
          placeholder="Access token" title="graph.instagram.com access token" />
        <div class="w-row" style="gap:5px">
          <input data-user-input class="search" style="margin:0;padding:3px 6px;font-size:11px;flex:1;min-width:0" placeholder="User ID (optional)" />
          <button class="w-btn" data-save style="padding:3px 10px;font-size:11px;flex:0 0 auto">Connect</button>
        </div>
        ${hint ? `<div class="w-error">${hint}</div>` : ""}
      </div>`;

    const showUser = () => {
      const el = body.querySelector<HTMLElement>("[data-user]");
      if (el) el.textContent = username ? `@${username}` : userId ? `#${userId}` : "Instagram";
    };

    const setNote = (text: string) => {
      const el = body.querySelector<HTMLElement>("[data-note]");
      if (el) el.textContent = text;
    };

    const setCount = (text: string, title: string) => {
      const el = body.querySelector<HTMLElement>("[data-count]");
      if (el) {
        el.textContent = text;
        el.title = title;
      }
    };

    const showMain = () => {
      view = "main";
      body.innerHTML = mainView();
      showUser();
      setCount("–", "");
      setNote("");
      q<HTMLButtonElement>("[data-refresh]").addEventListener("click", () => void refresh());
      q<HTMLButtonElement>("[data-key]").addEventListener("click", () => {
        ctx.setSettings({ accessToken: "" });
      });
    };

    const showConnect = (hint: string) => {
      view = "connect";
      body.innerHTML = connectView(hint);
      const tokenInput = q<HTMLInputElement>("[data-token]");
      const userInput = q<HTMLInputElement>("[data-user-input]");
      if (userId) userInput.value = userId;
      const save = () => {
        const nextToken = tokenInput.value.trim();
        const nextUser = userInput.value.trim();
        if (!nextToken) return;
        const patch: Record<string, unknown> = { accessToken: nextToken };
        patch.userId = nextUser;
        ctx.setSettings(patch);
      };
      q<HTMLButtonElement>("[data-save]").addEventListener("click", save);
      tokenInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") save();
      });
      userInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") save();
      });
    };

    const refresh = async () => {
      if (!accessToken || rejected) {
        showConnect(rejected ? "Token rejected — paste a new one" : "");
        return;
      }
      if (view === "connect") showMain();
      if (loading) return;
      loading = true;
      try {
        const res = await fetchWithTimeout(profileUrl(accessToken), 8000);
        if (res.status === 400 || res.status === 401 || res.status === 403) {
          rejected = true;
          showConnect("Token rejected — paste a new one");
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as IgProfile;
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
      } catch {
        setCount("–", "");
        setNote("offline");
      } finally {
        loading = false;
      }
    };

    const offSettings = ctx.onSettings((s) => {
      const nextToken = asString(s.accessToken);
      const nextUser = asString(s.userId);
      const changedToken = nextToken !== accessToken;
      accessToken = nextToken;
      userId = nextUser;
      if (changedToken) {
        rejected = false;
        view = nextToken ? "main" : "connect";
        if (nextToken) showMain();
        else showConnect("");
      }
      if (nextToken) void refresh();
    });

    if (accessToken) showMain();
    else showConnect("");
    if (accessToken) void refresh();

    return {
      refresh,
      destroy: () => offSettings(),
    };
  },
};

export default mod;
