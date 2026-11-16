import type { WidgetModule } from "../../core/types";
import { icons } from "../icons";

interface HNItem {
  id: number;
  title?: string;
  url?: string;
  score?: number;
}

const TOP_URL = "https://hacker-news.firebaseio.com/v0/topstories.json";
const ITEM_URL = (id: number) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;
const COUNT = 8;

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
  id: "hackernews-top",
  name: "Hacker News",
  group: "online",
  description: "Top stories with scores",
  icon: icons.trend,
  defaultSize: { w: 3, h: 2 },
  refreshMs: 300000,
  async mount(body, ctx) {
    body.innerHTML = `
      <div class="w-col" style="height:100%;gap:4px">
        <div class="w-row w-title" style="justify-content:space-between">
          <span class="w-row" style="gap:5px">
            <span class="w-icon w-warn" style="width:14px;height:14px">${icons.trend}</span>
            <span>Hacker News</span>
          </span>
          <button class="w-btn" data-refresh title="Refresh">↻</button>
        </div>
        <div data-list class="w-col" style="gap:3px;flex:1;min-height:0;overflow:auto">
          <div class="w-faint" style="font-size:11px">loading…</div>
        </div>
      </div>`;

    const list = body.querySelector<HTMLElement>("[data-list]")!;

    let ac: AbortController | null = null;
    let busy = false;

    const openUrl = async (url: string) => {
      try {
        await ctx.invoke("open_path", { path: url });
      } catch {
        window.open(url, "_blank", "noopener");
      }
    };

    list.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-url]");
      const url = el?.dataset.url;
      if (url) void openUrl(url);
    });

    const render = (items: HNItem[]) => {
      list.innerHTML = "";
      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "w-error";
        empty.textContent = "no stories";
        list.appendChild(empty);
        return;
      }
      for (const item of items) {
        const row = document.createElement("div");
        row.className = "w-row";
        row.style.cssText = "gap:6px;font-size:11px;align-items:baseline";
        const score = document.createElement("span");
        score.className = "w-faint w-mono";
        score.style.cssText = "flex:0 0 auto;font-size:10px;min-width:22px;text-align:right";
        score.textContent = String(item.score ?? 0);
        const title = document.createElement("span");
        title.dataset.url = item.url ?? `https://news.ycombinator.com/item?id=${item.id}`;
        title.textContent = item.title ?? "";
        title.style.cssText =
          "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer";
        row.append(score, title);
        list.appendChild(row);
      }
    };

    const refresh = async () => {
      if (busy) return;
      busy = true;
      ac?.abort();
      const ctrl = new AbortController();
      ac = ctrl;
      try {
        const idsRes = await fetchTimeout(TOP_URL, { signal: ctrl.signal }, 10000);
        if (!idsRes.ok) throw new Error(`HTTP ${idsRes.status}`);
        const ids = (await idsRes.json()) as number[];
        const top = Array.isArray(ids) ? ids.slice(0, COUNT) : [];
        const items = await Promise.all(
          top.map(async (id) => {
            try {
              const r = await fetchTimeout(ITEM_URL(id), { signal: ctrl.signal }, 10000);
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              return (await r.json()) as HNItem;
            } catch {
              return null;
            }
          }),
        );
        if (ctrl.signal.aborted) return;
        render(items.filter((x): x is HNItem => !!x && !!x.title));
      } catch {
        if (ctrl.signal.aborted) return;
        render([]);
      } finally {
        busy = false;
      }
    };

    body.querySelector<HTMLButtonElement>("[data-refresh]")!.addEventListener("click", () => {
      void refresh();
    });

    await refresh();
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
