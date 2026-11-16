import type { WidgetModule } from "../../core/types";

const tikTokIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 2v12.4a4.3 4.3 0 1 1-4.3-4.3"/><path d="M13.5 2c.6 3.5 3 5.7 6.5 6.1"/></svg>`;

const editIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l11-11a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5z"/></svg>`;

interface TikTokStats {
  followerCount?: number;
  followingCount?: number;
  heartCount?: number;
}

const asString = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const compact = (n: number): string => {
  if (!Number.isFinite(n) || n < 0) return "–";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return String(Math.round(n));
};

const num = (src: Record<string, unknown>, keys: string[]): number | undefined => {
  for (const k of keys) {
    const v = src[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
};

/** Pull follower/following/like counts out of any of the shapes the public endpoints return. */
const readStats = (data: unknown): TikTokStats | null => {
  if (!data || typeof data !== "object") return null;
  const root = data as Record<string, unknown>;
  const info =
    root.userInfo && typeof root.userInfo === "object"
      ? (root.userInfo as Record<string, unknown>)
      : root;
  const stats =
    info.stats && typeof info.stats === "object"
      ? (info.stats as Record<string, unknown>)
      : info;
  const out: TikTokStats = {
    followerCount: num(stats, ["followerCount", "follower_count", "fansCount", "followers"]),
    followingCount: num(stats, ["followingCount", "following_count", "following"]),
    heartCount: num(stats, ["heartCount", "heart_count", "likes", "likeCount", "diggCount"]),
  };
  if (out.followerCount === undefined && out.followingCount === undefined && out.heartCount === undefined) {
    return null;
  }
  return out;
};

const readHtmlStats = (html: string): TikTokStats | null => {
  const pick = (re: RegExp): number | undefined => {
    const m = re.exec(html);
    if (!m) return undefined;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : undefined;
  };
  return readStats({
    stats: {
      followerCount: pick(/"followerCount"\s*:\s*(\d+)/),
      followingCount: pick(/"followingCount"\s*:\s*(\d+)/),
      heartCount: pick(/"heartCount"\s*:\s*(\d+)/),
    },
  });
};

/** fetch that never hangs: TikTok's endpoints are usually CORS-blocked from a webview. */
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
  id: "tiktok-profile",
  name: "TikTok",
  group: "social",
  description: "Profile followers, following and likes",
  icon: tikTokIcon,
  defaultSize: { w: 2, h: 1 },
  refreshMs: 300000,
  mount(body, ctx) {
    let username = asString(ctx.settings.username);
    let loading = false;
    let view: "main" | "connect" = username ? "main" : "connect";

    const q = <T extends HTMLElement>(sel: string): T => body.querySelector<T>(sel)!;

    const mainView = () => `
      <div class="w-row" style="justify-content:space-between;height:100%;gap:4px">
        <div class="w-col" style="gap:1px;min-width:0">
          <div class="w-row" style="gap:5px;min-width:0">
            <span data-user class="w-dim" style="font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
            <span data-note class="w-faint" style="font-size:9px"></span>
          </div>
          <div class="w-big w-mono" data-followers>–</div>
          <div class="w-row w-faint" style="gap:9px;font-size:9px">
            <span><b class="w-mono" data-following>–</b> following</span>
            <span><b class="w-mono" data-likes>–</b> likes</span>
          </div>
        </div>
        <div class="w-col" style="align-items:center;gap:5px;flex:0 0 auto">
          <div class="w-icon w-accent" style="width:22px;height:22px">${tikTokIcon}</div>
          <div class="w-row" style="gap:4px;flex:0 0 auto">
            <button class="w-btn" data-refresh style="padding:2px 6px;background:transparent;color:var(--text-faint)" title="Refresh">↻</button>
            <button class="w-btn" data-edit style="padding:2px 5px;background:transparent;color:var(--text-faint)" title="Change username"><span class="w-icon" style="width:12px;height:12px">${editIcon}</span></button>
          </div>
        </div>
      </div>`;

    const connectView = () => `
      <div class="w-col" style="gap:4px;height:100%;justify-content:center">
        <div class="w-row w-title" style="gap:5px">
          <span class="w-icon w-accent" style="width:13px;height:13px">${tikTokIcon}</span>
          <span>Connect TikTok</span>
        </div>
        <div class="w-row" style="gap:5px">
          <input data-username class="search" style="margin:0;padding:3px 6px;font-size:11px;flex:1;min-width:0" placeholder="Username (without @)" />
          <button class="w-btn" data-save style="padding:3px 10px;font-size:11px;flex:0 0 auto">Save</button>
        </div>
        <div class="w-faint" style="font-size:9px">Counts stay “–” if blocked.</div>
      </div>`;

    const showUser = () => {
      const el = body.querySelector<HTMLElement>("[data-user]");
      if (el) el.textContent = username ? `@${username}` : "TikTok";
    };

    const setNote = (text: string) => {
      const el = body.querySelector<HTMLElement>("[data-note]");
      if (el) el.textContent = text;
    };

    const setStat = (sel: string, value: number | undefined, title: string) => {
      const el = body.querySelector<HTMLElement>(sel);
      if (!el) return;
      el.textContent = value === undefined ? "–" : compact(value);
      el.title = title;
    };

    const showMain = () => {
      view = "main";
      body.innerHTML = mainView();
      showUser();
      setNote("");
      setStat("[data-followers]", undefined, "");
      setStat("[data-following]", undefined, "");
      setStat("[data-likes]", undefined, "");
      q<HTMLButtonElement>("[data-refresh]").addEventListener("click", () => void refresh());
      q<HTMLButtonElement>("[data-edit]").addEventListener("click", () => {
        ctx.setSettings({ username: "" });
      });
    };

    const showConnect = () => {
      view = "connect";
      body.innerHTML = connectView();
      const input = q<HTMLInputElement>("[data-username]");
      const save = () => {
        const next = input.value.trim().replace(/^@/, "");
        if (next) ctx.setSettings({ username: next });
      };
      q<HTMLButtonElement>("[data-save]").addEventListener("click", save);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") save();
      });
    };

    const refresh = async () => {
      if (!username) {
        showConnect();
        return;
      }
      if (view === "connect") showMain();
      if (loading) return;
      loading = true;
      try {
        let stats: TikTokStats | null = null;
        const user = encodeURIComponent(username);
        for (const url of [
          `https://www.tiktok.com/api/user/detail/?uniqueId=${user}`,
          `https://tiktok.com/api/user/detail/?uniqueId=${user}`,
        ]) {
          try {
            const res = await fetchWithTimeout(url, 7000);
            if (!res.ok) continue;
            stats = readStats((await res.json()) as unknown);
            if (stats) break;
          } catch {
            // endpoint unreachable or CORS-blocked — try the next one
          }
        }
        if (!stats) {
          try {
            const res = await fetchWithTimeout(`https://www.tiktok.com/@${user}`, 7000);
            if (res.ok) stats = readHtmlStats(await res.text());
          } catch {
            // profile page not reachable either
          }
        }
        if (!stats) {
          setStat("[data-followers]", undefined, "");
          setStat("[data-following]", undefined, "");
          setStat("[data-likes]", undefined, "");
          setNote("connect");
          return;
        }
        setStat("[data-followers]", stats.followerCount, "followers");
        setStat("[data-following]", stats.followingCount, "following");
        setStat("[data-likes]", stats.heartCount, "likes");
        setNote("");
      } catch {
        setStat("[data-followers]", undefined, "");
        setStat("[data-following]", undefined, "");
        setStat("[data-likes]", undefined, "");
        setNote("connect");
      } finally {
        loading = false;
      }
    };

    const offSettings = ctx.onSettings((s) => {
      const next = asString(s.username);
      if (next === username) return;
      username = next;
      if (username) showMain();
      else showConnect();
      if (username) void refresh();
    });

    if (username) showMain();
    else showConnect();
    if (username) void refresh();

    return {
      refresh,
      destroy: () => offSettings(),
    };
  },
};

export default mod;
