import { fetchJson, isAbortError, isHttpError } from "../../core/http";
import type { WidgetModule } from "../../core/types";
import { hasTauri } from "../../core/tauri";
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

function validateWebUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const schemeEnd = trimmed.indexOf("://");
  if (schemeEnd === -1) return null;
  const authority = trimmed.slice(schemeEnd + 3).split(/[/?#]/, 1)[0] ?? "";
  if (authority.includes("@")) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname) return null;
    if (parsed.username !== "" || parsed.password !== "") return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function hnItemUrl(item: HNItem): string | null {
  const safe = validateWebUrl(item.url);
  if (safe) return safe;
  if (typeof item.id === "number" && Number.isSafeInteger(item.id) && item.id > 0) {
    return `https://news.ycombinator.com/item?id=${item.id}`;
  }
  return null;
}

function isTauriRuntime(): boolean {
  return (
    hasTauri ||
    (typeof window !== "undefined" &&
      ("__TAURI__" in window || "__TAURI_INTERNALS__" in window))
  );
}

const mod: WidgetModule = {
  id: "hackernews-top",
  name: "Hacker News",
  group: "online",
  description: "Top stories with scores",
  icon: icons.trend,
  defaultSize: { w: 3, h: 2 },
  refreshMs: 300000,
  mount(body, ctx) {
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

    type ActiveJob = {
      gen: number;
      controller: AbortController;
      promise: Promise<void>;
    };
    let alive = !ctx.signal?.aborted;
    let generation = 0;
    let activeJob: ActiveJob | null = null;
    let retryUntil = 0;

    const cleanup = () => {
      if (!alive) return;
      alive = false;
      generation++;
      activeJob?.controller.abort();
      activeJob = null;
      ctx.signal?.removeEventListener("abort", cleanup);
    };
    if (ctx.signal) {
      if (ctx.signal.aborted) {
        alive = false;
      } else {
        ctx.signal.addEventListener("abort", cleanup, { once: true });
      }
    }

    const openUrl = async (raw: string) => {
      const safe = validateWebUrl(raw);
      if (!safe) return;
      if (isTauriRuntime()) {
        try {
          await ctx.invoke("open_web_url", { url: safe });
        } catch {
          /* do not fall back to window.open inside Tauri */
        }
        return;
      }
      try {
        await ctx.invoke("open_web_url", { url: safe });
      } catch {
        window.open(safe, "_blank", "noopener");
      }
    };

    list.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-url]");
      const url = el?.dataset.url;
      if (url) void openUrl(url);
    });

    const render = (items: HNItem[], emptyText = "no stories") => {
      if (!alive) return;
      list.innerHTML = "";
      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "w-error";
        empty.textContent = emptyText;
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
        const safeUrl = hnItemUrl(item);
        if (safeUrl) title.dataset.url = safeUrl;
        title.textContent = item.title ?? "";
        title.style.cssText =
          "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" +
          (safeUrl ? ";cursor:pointer" : "");
        row.append(score, title);
        list.appendChild(row);
      }
    };

    const refresh = (): Promise<void> => {
      if (!alive) return Promise.resolve();
      if (activeJob) return activeJob.promise;
      if (Date.now() < retryUntil) {
        render([], "rate limited");
        return Promise.resolve();
      }

      const jobGen = ++generation;
      const controller = new AbortController();
      let job!: ActiveJob;

      const promise = (async () => {
        try {
          const idsRes = await fetchJson<number[]>(TOP_URL, {
            signal: controller.signal,
            timeoutMs: 10_000,
            allowNotModified: true,
          });
          if (!alive || jobGen !== generation || controller.signal.aborted) return;
          if (idsRes.noContent) return;
          const ids = Array.isArray(idsRes.data) ? idsRes.data : [];
          const top = ids.slice(0, COUNT);
          let itemRateLimitMs: number | null = null;
          const items = await Promise.all(
            top.map(async (id) => {
              if (!alive || jobGen !== generation || controller.signal.aborted) return null;
              try {
                const r = await fetchJson<HNItem>(ITEM_URL(id), {
                  signal: controller.signal,
                  timeoutMs: 10_000,
                  allowNotModified: true,
                });
                return !r.noContent && r.data ? r.data : null;
              } catch (err) {
                if (isHttpError(err, "http") && err.status === 429) {
                  const delay = err.retryAfterMs ?? 60_000;
                  itemRateLimitMs = itemRateLimitMs === null ? delay : Math.max(itemRateLimitMs, delay);
                }
                return null;
              }
            }),
          );
          if (!alive || jobGen !== generation || controller.signal.aborted) return;
          const valid = items.filter((x): x is HNItem => !!x && !!x.title);
          if (!valid.length && itemRateLimitMs !== null) {
            retryUntil = Date.now() + itemRateLimitMs;
            render([], "rate limited");
            return;
          }
          retryUntil = 0;
          render(valid);
        } catch (err) {
          if (isAbortError(err)) return;
          if (!alive || jobGen !== generation || controller.signal.aborted) return;
          if (isHttpError(err, "http")) {
            if (err.status === 429) {
              retryUntil = Date.now() + (err.retryAfterMs ?? 60_000);
              render([], "rate limited");
              return;
            }
            if (err.status === 401 || err.status === 403) {
              render([], `auth ${err.status}`);
              return;
            }
            render([], `HTTP ${err.status}`);
            return;
          }
          if (isHttpError(err, "timeout")) {
            render([], "timeout");
            return;
          }
          render([], "no stories");
        } finally {
          if (activeJob === job) {
            activeJob = null;
          }
        }
      })();

      job = { gen: jobGen, controller, promise };
      activeJob = job;
      return promise;
    };

    body.querySelector<HTMLButtonElement>("[data-refresh]")!.addEventListener("click", () => {
      void refresh();
    });

    if (alive) void refresh();
    return {
      refresh,
      destroy: cleanup,
    };
  },
};

export default mod;
