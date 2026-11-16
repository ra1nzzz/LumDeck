import type { WidgetModule } from "../../core/types";
import { icons } from "../icons";

interface GmailLabel {
  messagesUnread?: number;
}

const LABELS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/labels/INBOX";

/** fetch with a timeout; an externally supplied signal is honoured too. */
async function fetchTimeout(url: string, opts: RequestInit = {}, ms = 10000): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  const outer = opts.signal;
  const onAbort = () => ac.abort();
  if (outer) {
    if (outer.aborted) ac.abort();
    else outer.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
    outer?.removeEventListener("abort", onAbort);
  }
}

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
    try {
      token = ((await ctx.getSecret("accessToken")) ?? "").trim();
    } catch {
      token = "";
    }

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
        <input data-token class="search" style="margin:0;padding:4px 7px;font-size:11px"
          placeholder="Paste access token (gmail.readonly)" />
        <button class="w-btn" data-save style="align-self:flex-start">Save</button>
        ${hint ? `<div class="w-error">${hint}</div>` : ""}
      </div>`;

    let view: "" | "main" | "connect" = "";
    let ac: AbortController | null = null;
    let busy = false;

    const showMain = () => {
      if (view === "main") return;
      view = "main";
      body.innerHTML = mainHtml;
      body.querySelector<HTMLButtonElement>("[data-refresh]")!.addEventListener("click", () => {
        void refresh();
      });
    };

    const showConnect = (hint: string) => {
      view = "connect";
      body.innerHTML = connectHtml(hint);
      const input = body.querySelector<HTMLInputElement>("[data-token]")!;
      const save = async () => {
        const value = input.value.trim();
        if (!value) return;
        token = value;
        await ctx.setSecret("accessToken", value);
        showMain();
        void refresh();
      };
      body.querySelector<HTMLButtonElement>("[data-save]")!.addEventListener("click", save);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") save();
      });
    };

    const setCount = (text: string, label: string) => {
      const c = body.querySelector<HTMLElement>("[data-count]");
      const l = body.querySelector<HTMLElement>("[data-label]");
      if (c) c.textContent = text;
      if (l) l.textContent = label;
    };

    const refresh = async () => {
      const t = token;
      if (!t) {
        showConnect("");
        return;
      }
      if (busy) return;
      busy = true;
      ac?.abort();
      const ctrl = new AbortController();
      ac = ctrl;
      if (view === "connect") showMain();
      setCount("…", "inbox");
      try {
        const res = await fetchTimeout(
          LABELS_URL,
          { headers: { Authorization: `Bearer ${t}` }, signal: ctrl.signal },
          10000,
        );
        if (ctrl.signal.aborted) return;
        if (res.status === 401) {
          showConnect("Token expired — paste a new one");
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as GmailLabel;
        const unread = typeof data.messagesUnread === "number" ? data.messagesUnread : 0;
        setCount(String(unread), "inbox");
      } catch {
        if (ctrl.signal.aborted) return;
        setCount("–", "inbox");
      } finally {
        busy = false;
      }
    };

    if (token) {
      showMain();
      await refresh();
    } else {
      showConnect("");
    }

    return {
      refresh,
      destroy: () => {
        ac?.abort();
        ac = null;
      },
    };
  },
};

export default mod;
