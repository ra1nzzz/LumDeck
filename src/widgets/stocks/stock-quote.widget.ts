import type { WidgetModule } from "../../core/types";
import { icons } from "../icons";

interface Quote {
  c: number;
  dp: number | null;
  h: number;
  l: number;
  o: number;
  pc: number;
}

const linkIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07L11 4.93"/><path d="M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 0 0 7.07 7.07L13 19.07"/></svg>`;

const asString = (v: unknown, fallback: string): string =>
  typeof v === "string" && v.trim() ? v : fallback;

const fmtPrice = (n: number): string => n.toFixed(2);

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
  id: "stock-quote",
  name: "Stock Quote",
  group: "stocks",
  description: "Live quote via Finnhub",
  icon: icons.trend,
  defaultSize: { w: 2, h: 1 },
  refreshMs: 60000,
  async mount(body, ctx) {
    let symbol = asString(ctx.settings.symbol, "AAPL").toUpperCase();
    let apiKey = "";
    try {
      apiKey = ((await ctx.getSecret("apiKey")) ?? "").trim();
    } catch {
      apiKey = "";
    }
    let loading = false;
    let token = 0;
    let ac: AbortController | null = null;

    const el = <T extends HTMLElement>(sel: string): T => body.querySelector<T>(sel)!;

    const quoteView = () => `
      <div class="w-row" style="justify-content:space-between;gap:8px;height:100%">
        <div class="w-col" style="gap:1px;min-width:0">
          <div class="w-row" style="gap:6px">
            <input data-sym class="search" style="margin:0;padding:2px 6px;font-size:12px;font-weight:700;width:74px" title="Edit symbol" />
            <span data-chg class="w-mono" style="font-size:12px;font-weight:650">–</span>
          </div>
          <div data-price class="w-big w-mono">–</div>
          <div data-range class="w-dim w-mono" style="font-size:10px">&nbsp;</div>
        </div>
        <div class="w-col" style="align-items:center;gap:6px;flex:0 0 auto">
          <div class="w-icon w-accent" style="width:22px;height:22px">${icons.trend}</div>
          <button data-key class="w-btn" style="padding:2px 6px;background:transparent;color:var(--text-faint)" title="Change API key">${linkIcon}</button>
        </div>
      </div>`;

    const connectView = () => `
      <div class="w-col" style="gap:6px;height:100%;justify-content:center">
        <div class="w-row w-title" style="gap:6px">
          <span class="w-icon w-accent" style="width:14px;height:14px">${icons.trend}</span>
          <span>Finnhub key required</span>
        </div>
        <div class="w-row" style="gap:6px">
          <input data-sym class="search" style="margin:0;padding:5px 8px;font-size:12px;width:70px" placeholder="Symbol" />
          <input data-key-input class="search" style="margin:0;padding:5px 8px;font-size:12px;flex:1" type="password" placeholder="API key" />
        </div>
        <button data-save class="w-btn" style="align-self:flex-start;padding:5px 12px">Connect</button>
      </div>`;

    const setStatus = (cls: string, text: string) => {
      const chg = el<HTMLElement>("[data-chg]");
      chg.textContent = text;
      chg.className = `w-mono ${cls}`;
    };

    const refresh = async () => {
      const my = ++token;
      if (loading) return;
      if (!apiKey) {
        render();
        return;
      }
      loading = true;
      ac?.abort();
      const ctrl = new AbortController();
      ac = ctrl;
      try {
        const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(apiKey)}`;
        const res = await fetchTimeout(url, { signal: ctrl.signal }, 10000);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const q = (await res.json()) as Partial<Quote>;
        if (my !== token) return;
        const price = el<HTMLElement>("[data-price]");
        const range = el<HTMLElement>("[data-range]");
        if (typeof q.c !== "number" || !Number.isFinite(q.c) || q.c <= 0) {
          price.textContent = "–";
          setStatus("w-faint", "no data");
          range.textContent = "\u00a0";
          return;
        }
        price.textContent = `$${fmtPrice(q.c)}`;
        if (typeof q.dp === "number" && Number.isFinite(q.dp)) {
          const up = q.dp >= 0;
          setStatus(up ? "w-good" : "w-bad", `${up ? "▲" : "▼"} ${Math.abs(q.dp).toFixed(2)}%`);
        } else {
          setStatus("w-faint", "–");
        }
        range.textContent =
          typeof q.h === "number" && typeof q.l === "number"
            ? `H ${fmtPrice(q.h)} · L ${fmtPrice(q.l)}`
            : "\u00a0";
      } catch {
        if (my !== token) return;
        el<HTMLElement>("[data-price]").textContent = "–";
        setStatus("w-faint", "offline");
        el<HTMLElement>("[data-range]").textContent = "\u00a0";
      } finally {
        loading = false;
      }
    };

    const render = () => {
      token++;
      loading = false;
      ac?.abort();
      body.innerHTML = apiKey ? quoteView() : connectView();
      const symInput = el<HTMLInputElement>("[data-sym]");
      symInput.value = symbol;
      symInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commitSymbol(symInput);
        }
      });
      if (apiKey) symInput.addEventListener("blur", () => commitSymbol(symInput));

      if (apiKey) {
        el<HTMLButtonElement>("[data-key]").addEventListener("click", () => {
          void (async () => {
            apiKey = "";
            await ctx.deleteSecret("apiKey");
            render();
          })();
        });
      } else {
        const keyInput = el<HTMLInputElement>("[data-key-input]");
        const save = async () => {
          const nextKey = keyInput.value.trim();
          const nextSym = symInput.value.trim().toUpperCase();
          if (!nextKey) return;
          apiKey = nextKey;
          await ctx.setSecret("apiKey", nextKey);
          if (nextSym) {
            symbol = nextSym;
            ctx.setSettings({ symbol: nextSym });
          }
          render();
          void refresh();
        };
        el<HTMLButtonElement>("[data-save]").addEventListener("click", save);
        keyInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") save();
        });
      }
    };

    const commitSymbol = (input: HTMLInputElement) => {
      const next = input.value.trim().toUpperCase();
      if (!next || next === symbol) {
        input.value = symbol;
        return;
      }
      ctx.setSettings({ symbol: next });
    };

    const unsub = ctx.onSettings((s) => {
      const nextSym = asString(s.symbol, "AAPL").toUpperCase();
      if (nextSym === symbol) return;
      symbol = nextSym;
      render();
      void refresh();
    });

    render();
    if (apiKey) void refresh();

    return {
      refresh,
      destroy: () => {
        ac?.abort();
        ac = null;
        unsub();
      },
    };
  },
};

export default mod;
