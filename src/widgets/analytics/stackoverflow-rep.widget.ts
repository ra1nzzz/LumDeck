import { fetchJson, isAbortError, isHttpError } from "../../core/http";
import type { WidgetModule } from "../../core/types";

const soIcon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="15" width="17" height="3.2" rx="0.8"/><path d="M5.5 12h13"/><path d="M7 9h10"/><path d="M8.5 6h7"/></svg>';

const refreshIcon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';

const dot = (color: string) =>
  `<i style="width:7px;height:7px;border-radius:50%;background:${color};display:inline-block;flex:none"></i>`;

interface SoUser {
  display_name?: unknown;
  reputation?: unknown;
  badge_counts?: { gold?: unknown; silver?: unknown; bronze?: unknown };
}

function compact(n: number): string {
  if (!Number.isFinite(n)) return "–";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

const mod: WidgetModule = {
  id: "stackoverflow-rep",
  name: "Stack Overflow",
  group: "analytics",
  description: "Reputation and badges",
  icon: soIcon,
  defaultSize: { w: 2, h: 1 },
  refreshMs: 300000,
  mount(body, ctx) {
    const readId = () => {
      const v = ctx.settings.userId;
      if (typeof v === "number") return String(v);
      if (typeof v === "string") return v.trim();
      return "";
    };
    const readSite = () => {
      const v = ctx.settings.site;
      return typeof v === "string" && v.trim() ? v.trim() : "stackoverflow";
    };
    let userId = readId();
    let site = readSite();

    let alive = true;
    let generation = 0;
    let activeJob: {
      key: string;
      gen: number;
      controller: AbortController;
      promise: Promise<void>;
    } | null = null;
    let retryUntil = 0;
    let offSettings: (() => void) | null = null;

    const renderConnect = () => {
      body.innerHTML = `
        <div class="w-col" style="gap:6px;height:100%;justify-content:center">
          <div class="w-row" style="gap:6px">
            <span class="w-icon w-accent" style="width:16px;height:16px">${soIcon}</span>
            <span class="w-title">Connect Stack Overflow</span>
          </div>
          <div class="w-row" style="gap:6px">
            <input data-uid class="search" style="margin:0;padding:4px 7px;font-size:11px;flex:1;min-width:0" placeholder="User ID" inputmode="numeric" />
            <button data-save class="w-btn" style="padding:4px 8px">Save</button>
          </div>
        </div>`;
      const input = body.querySelector<HTMLInputElement>("[data-uid]")!;
      const save = body.querySelector<HTMLButtonElement>("[data-save]")!;
      const doSave = () => {
        const v = input.value.trim();
        if (!v) return;
        ctx.setSettings({ userId: v });
        applyConfig(v, site);
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
            <div class="w-big w-mono" data-rep>–</div>
            <div class="w-dim" style="font-size:11px" data-name>&nbsp;</div>
            <div class="w-row" style="gap:8px;font-size:10px;margin-top:3px">
              <span class="w-row" style="gap:3px">${dot("var(--warn)")}<span class="w-mono" data-gold>0</span></span>
              <span class="w-row" style="gap:3px">${dot("#cbd5e1")}<span class="w-mono" data-silver>0</span></span>
              <span class="w-row" style="gap:3px">${dot("#cd7f32")}<span class="w-mono" data-bronze>0</span></span>
            </div>
          </div>
          <div class="w-row" style="gap:6px">
            <span class="w-icon w-accent" style="width:22px;height:22px">${soIcon}</span>
            <button data-refresh class="w-btn" style="padding:5px 6px;display:inline-flex" title="Refresh">
              <span class="w-icon" style="width:13px;height:13px">${refreshIcon}</span>
            </button>
          </div>
        </div>`;
      body.querySelector<HTMLButtonElement>("[data-refresh]")!.addEventListener("click", () => {
        void refresh();
      });
    };

    const setBadge = (sel: string, v: unknown) => {
      const el = body.querySelector<HTMLElement>(sel);
      if (el) el.textContent = typeof v === "number" ? String(v) : "0";
    };

    const showData = (rep: string, name: string) => {
      const r = body.querySelector<HTMLElement>("[data-rep]");
      const n = body.querySelector<HTMLElement>("[data-name]");
      if (r) r.textContent = rep;
      if (n) n.textContent = name;
    };

    const showFallback = (msg: string) => {
      const r = body.querySelector<HTMLElement>("[data-rep]");
      const n = body.querySelector<HTMLElement>("[data-name]");
      if (r) r.textContent = "–";
      if (n) n.textContent = msg;
      setBadge("[data-gold]", 0);
      setBadge("[data-silver]", 0);
      setBadge("[data-bronze]", 0);
    };

    const refresh = (): Promise<void> => {
      if (!alive || !userId) return Promise.resolve();
      const targetUserId = userId;
      const targetSite = site;
      const key = `${targetUserId}\0${targetSite}`;
      if (activeJob && activeJob.key === key) {
        return activeJob.promise;
      }

      if (Date.now() < retryUntil) {
        showFallback("rate limited");
        return Promise.resolve();
      }

      activeJob?.controller.abort();
      const jobGen = ++generation;
      const controller = new AbortController();
      const url = `https://api.stackexchange.com/2.3/users/${encodeURIComponent(targetUserId)}?site=${encodeURIComponent(targetSite)}`;

      const promise = (async () => {
        try {
          const res = await fetchJson<{ items?: SoUser[] }>(url, {
            signal: controller.signal,
            timeoutMs: 10_000,
          });
          if (!alive || jobGen !== generation || controller.signal.aborted) return;
          if (res.noContent || !res.data) {
            showFallback("not found");
            return;
          }
          const u =
            Array.isArray(res.data.items) && res.data.items.length ? res.data.items[0] : null;
          if (!u) {
            showFallback("not found");
            return;
          }
          retryUntil = 0;
          const rep = typeof u.reputation === "number" ? u.reputation : NaN;
          const name = typeof u.display_name === "string" && u.display_name ? u.display_name : "—";
          showData(compact(rep), name);
          const bc = u.badge_counts ?? {};
          setBadge("[data-gold]", bc.gold);
          setBadge("[data-silver]", bc.silver);
          setBadge("[data-bronze]", bc.bronze);
        } catch (err) {
          if (isAbortError(err)) return;
          if (!alive || jobGen !== generation || controller.signal.aborted) return;
          if (isHttpError(err, "http")) {
            if (err.status === 429) {
              retryUntil = Date.now() + (err.retryAfterMs ?? 60_000);
              showFallback("rate limited");
            } else if (err.status === 401 || err.status === 403) {
              showFallback(`auth ${err.status}`);
            } else {
              showFallback(`SE ${err.status}`);
            }
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

      activeJob = { key, gen: jobGen, controller, promise };
      return promise;
    };

    const route = () => {
      if (userId) {
        renderConnected();
        void refresh();
      } else {
        renderConnect();
      }
    };

    const applyConfig = (nextId: string, nextSite: string) => {
      if (!alive || (nextId === userId && nextSite === site)) return;
      userId = nextId;
      site = nextSite;
      generation++;
      activeJob?.controller.abort();
      activeJob = null;
      retryUntil = 0;
      route();
    };

    offSettings = ctx.onSettings((s) => {
      const id =
        typeof s.userId === "number"
          ? String(s.userId)
          : typeof s.userId === "string"
            ? s.userId.trim()
            : "";
      const st = typeof s.site === "string" && s.site.trim() ? s.site.trim() : "stackoverflow";
      applyConfig(id, st);
    });

    route();

    return {
      refresh,
      destroy: () => {
        alive = false;
        generation++;
        activeJob?.controller.abort();
        activeJob = null;
        if (offSettings) offSettings();
      },
    };
  },
};

export default mod;
