import type { WidgetModule } from "../../core/types";

const githubIcon =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.23-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>';

const refreshIcon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';

/** Read the `rel="last"` page number from a GitHub Link header, if present. */
function parseLastPage(link: string | null): number | null {
  if (!link) return null;
  const m = link.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/);
  return m ? Number(m[1]) : null;
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
    try {
      token = ((await ctx.getSecret("token")) ?? "").trim();
    } catch {
      token = "";
    }

    let abort: AbortController | null = null;

    const renderConnect = () => {
      body.innerHTML = `
        <div class="w-col" style="gap:6px;height:100%;justify-content:center">
          <div class="w-row" style="gap:6px">
            <span class="w-icon w-accent" style="width:16px;height:16px">${githubIcon}</span>
            <span class="w-title">Connect GitHub</span>
          </div>
          <div class="w-row" style="gap:6px">
            <input data-token type="password" class="search" style="margin:0;padding:4px 7px;font-size:11px;flex:1;min-width:0" placeholder="Personal access token" />
            <button data-save class="w-btn" style="padding:4px 8px">Save</button>
          </div>
        </div>`;
      const input = body.querySelector<HTMLInputElement>("[data-token]")!;
      const save = body.querySelector<HTMLButtonElement>("[data-save]")!;
      const doSave = () => {
        const v = input.value.trim();
        if (!v) return;
        token = v;
        void ctx.setSecret("token", v);
        route();
      };
      save.addEventListener("click", doSave);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") doSave();
      });
    };

    const renderConnected = () => {
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
      const c = body.querySelector<HTMLElement>("[data-count]");
      const l = body.querySelector<HTMLElement>("[data-login]");
      if (c) {
        c.textContent = "–";
        c.classList.remove("w-good", "w-accent");
      }
      if (l) l.textContent = msg;
    };

    const refresh = async () => {
      if (!token) return;
      if (abort) abort.abort();
      abort = new AbortController();
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      };
      try {
        const [userRes, notifRes] = await Promise.all([
          fetch("https://api.github.com/user", { headers, signal: abort.signal }),
          fetch("https://api.github.com/notifications?per_page=1", {
            headers,
            signal: abort.signal,
          }),
        ]);
        if (userRes.status === 401 || notifRes.status === 401) {
          showFallback("Invalid token");
          return;
        }
        if (!userRes.ok) {
          showFallback(`GitHub ${userRes.status}`);
          return;
        }
        if (!notifRes.ok) {
          showFallback(`GitHub ${notifRes.status}`);
          return;
        }
        const user = (await userRes.json()) as { login?: unknown };
        const notifs = (await notifRes.json()) as unknown;
        const list = Array.isArray(notifs) ? notifs : [];
        // With per_page=1 the `rel="last"` page number equals the unread total.
        const last = parseLastPage(notifRes.headers.get("Link"));
        const unread = last != null ? last : list.length;
        const login = typeof user.login === "string" && user.login ? user.login : "—";
        showData(String(unread), login, unread);
      } catch (e) {
        if ((e as { name?: string })?.name === "AbortError") return;
        showFallback("offline");
      }
    };

    const route = () => {
      if (token) {
        renderConnected();
        void refresh();
      } else {
        renderConnect();
      }
    };

    route();

    return {
      refresh,
      destroy: () => {
        if (abort) abort.abort();
      },
    };
  },
};

export default mod;
