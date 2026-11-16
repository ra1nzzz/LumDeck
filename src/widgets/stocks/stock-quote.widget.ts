import { sanitizeSecretError } from "../../core/credentials";
import { fetchJson, isAbortError, isHttpError } from "../../core/http";
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
    let generation = 0;
    let activeJob: {
      key: string;
      gen: number;
      controller: AbortController;
      promise: Promise<void>;
    } | null = null;
    let authRejected = false;
    let retryUntil = 0;
    let destroyed = false;
    let secretOp = false;
    let view: "" | "quote" | "connect" | "vault-error" = "";

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

    const connectView = (hint: string) => `
      <div class="w-col" style="gap:4px;height:100%;justify-content:center">
        <div class="w-row w-title" style="gap:6px">
          <span class="w-icon w-accent" style="width:14px;height:14px">${icons.trend}</span>
          <span>Finnhub key required</span>
        </div>
        <div class="w-row" style="gap:6px">
          <input data-sym class="search" style="margin:0;padding:4px 7px;font-size:12px;width:70px" placeholder="Symbol" />
          <input data-key-input class="search" style="margin:0;padding:4px 7px;font-size:12px;flex:1" type="password" spellcheck="false" autocomplete="off" placeholder="API key" />
        </div>
        <div class="w-row" style="gap:6px;align-items:center">
          <button data-save class="w-btn" style="padding:4px 10px;flex:0 0 auto">Connect</button>
          <span data-err class="w-error" style="font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${hint.replace(/[<>&"']/g, "")}</span>
        </div>
      </div>`;

    const setStatus = (cls: string, text: string) => {
      if (destroyed) return;
      const chg = body.querySelector<HTMLElement>("[data-chg]");
      if (!chg) return;
      chg.textContent = text;
      chg.className = `w-mono ${cls}`;
    };

    const setQuoteFallback = (cls: string, text: string) => {
      if (destroyed) return;
      const price = body.querySelector<HTMLElement>("[data-price]");
      const range = body.querySelector<HTMLElement>("[data-range]");
      if (price) price.textContent = "–";
      setStatus(cls, text);
      if (range) range.textContent = "\u00a0";
    };

    const refresh = (): Promise<void> => {
      if (destroyed) return Promise.resolve();
      const targetKey = apiKey;
      const targetSymbol = symbol;
      if (!targetKey || authRejected) {
        if (view !== "connect") {
          render(authRejected ? "Invalid API key — paste a new one" : "");
        }
        return Promise.resolve();
      }
      if (view !== "quote") render();

      const key = `${targetKey}\0${targetSymbol}`;
      if (activeJob && activeJob.key === key) {
        return activeJob.promise;
      }

      if (Date.now() < retryUntil) {
        setQuoteFallback("w-faint", "rate limited");
        return Promise.resolve();
      }

      activeJob?.controller.abort();
      const jobGen = ++generation;
      const controller = new AbortController();
      const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(targetSymbol)}&token=${encodeURIComponent(targetKey)}`;

      const promise = (async () => {
        try {
          const res = await fetchJson<Partial<Quote>>(url, {
            signal: controller.signal,
            timeoutMs: 10_000,
            allowNotModified: true,
          });
          if (destroyed || jobGen !== generation || controller.signal.aborted) return;
          retryUntil = 0;
          if (res.noContent || !res.data) {
            if (res.status === 304) return;
            setQuoteFallback("w-faint", "no data");
            return;
          }
          const q = res.data;
          const price = el<HTMLElement>("[data-price]");
          const range = el<HTMLElement>("[data-range]");
          if (typeof q.c !== "number" || !Number.isFinite(q.c) || q.c <= 0) {
            setQuoteFallback("w-faint", "no data");
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
        } catch (err) {
          if (isAbortError(err)) return;
          if (destroyed || jobGen !== generation || controller.signal.aborted) return;
          if (isHttpError(err, "http")) {
            if (err.status === 401) {
              authRejected = true;
              render("Invalid API key — paste a new one");
              return;
            }
            if (err.status === 403) {
              setQuoteFallback("w-bad", "auth 403");
              return;
            }
            if (err.status === 429) {
              retryUntil = Date.now() + (err.retryAfterMs ?? 60_000);
              setQuoteFallback("w-faint", "rate limited");
              return;
            }
            setQuoteFallback("w-faint", `HTTP ${err.status}`);
            return;
          }
          if (isHttpError(err, "timeout")) {
            setQuoteFallback("w-faint", "timeout");
            return;
          }
          if (isHttpError(err, "decode")) {
            setQuoteFallback("w-faint", "bad response");
            return;
          }
          setQuoteFallback("w-faint", "offline");
        } finally {
          if (activeJob?.gen === jobGen) {
            activeJob = null;
          }
        }
      })();

      activeJob = { key, gen: jobGen, controller, promise };
      return promise;
    };

    const renderVaultError = (msg: string) => {
      if (destroyed) return;
      view = "vault-error";
      body.innerHTML = `
        <div class="w-col" style="gap:5px;height:100%;justify-content:center">
          <div class="w-row w-title" style="gap:6px">
            <span class="w-icon w-accent" style="width:14px;height:14px">${icons.trend}</span>
            <span>Credential vault error</span>
          </div>
          <div class="w-row" style="gap:6px;justify-content:space-between">
            <span data-err class="w-error" style="font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${msg.replace(/[<>&"']/g, "")}</span>
            <button data-retry class="w-btn" style="padding:3px 8px;flex:0 0 auto">Retry</button>
          </div>
        </div>`;
      el<HTMLButtonElement>("[data-retry]").addEventListener("click", () => {
        void init();
      });
    };

    const render = (hint = "") => {
      if (destroyed) return;
      const showQuote = Boolean(apiKey) && !authRejected;
      view = showQuote ? "quote" : "connect";
      body.innerHTML = showQuote ? quoteView() : connectView(hint);
      const symInput = el<HTMLInputElement>("[data-sym]");
      symInput.value = symbol;
      symInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commitSymbol(symInput);
        }
      });
      if (showQuote) symInput.addEventListener("blur", () => commitSymbol(symInput));

      if (showQuote) {
        const keyBtn = el<HTMLButtonElement>("[data-key]");
        keyBtn.addEventListener("click", () => {
          if (secretOp || destroyed) return;
          secretOp = true;
          keyBtn.disabled = true;
          void (async () => {
            try {
              await ctx.deleteSecret("apiKey");
            } catch (err) {
              if (!destroyed) {
                setStatus("w-bad", "vault err");
                keyBtn.title = sanitizeSecretError(err, [apiKey]);
                keyBtn.disabled = false;
              }
              secretOp = false;
              return;
            }
            secretOp = false;
            if (destroyed) return;
            apiKey = "";
            authRejected = false;
            retryUntil = 0;
            generation++;
            activeJob?.controller.abort();
            activeJob = null;
            render();
          })();
        });
      } else {
        const keyInput = el<HTMLInputElement>("[data-key-input]");
        const saveBtn = el<HTMLButtonElement>("[data-save]");
        const errEl = el<HTMLElement>("[data-err]");
        const save = async () => {
          if (secretOp || destroyed) return;
          const nextKey = keyInput.value.trim();
          const nextSym = symInput.value.trim().toUpperCase();
          if (!nextKey) return;
          secretOp = true;
          saveBtn.disabled = true;
          errEl.textContent = "";
          try {
            await ctx.setSecret("apiKey", nextKey);
          } catch (err) {
            if (!destroyed) {
              errEl.textContent = sanitizeSecretError(err, [nextKey]);
              saveBtn.disabled = false;
            }
            secretOp = false;
            return;
          }
          secretOp = false;
          if (destroyed) return;
          apiKey = nextKey;
          authRejected = false;
          retryUntil = 0;
          generation++;
          activeJob?.controller.abort();
          activeJob = null;
          if (nextSym) {
            symbol = nextSym;
            ctx.setSettings({ symbol: nextSym });
          }
          render();
          void refresh();
        };
        saveBtn.addEventListener("click", () => {
          void save();
        });
        keyInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") void save();
        });
      }
    };

    const applySymbol = (nextSym: string) => {
      if (destroyed || nextSym === symbol) return;
      symbol = nextSym;
      generation++;
      activeJob?.controller.abort();
      activeJob = null;
      retryUntil = 0;
      if (apiKey && !authRejected) {
        render();
        void refresh();
      } else {
        const symInput = body.querySelector<HTMLInputElement>("[data-sym]");
        if (symInput && document.activeElement !== symInput) {
          symInput.value = symbol;
        }
      }
    };

    const commitSymbol = (input: HTMLInputElement) => {
      const next = input.value.trim().toUpperCase();
      if (!next || next === symbol) {
        input.value = symbol;
        return;
      }
      ctx.setSettings({ symbol: next });
      applySymbol(next);
    };

    const unsub = ctx.onSettings((s) => {
      applySymbol(asString(s.symbol, "AAPL").toUpperCase());
    });

    const cleanup = () => {
      if (destroyed) return;
      destroyed = true;
      generation++;
      activeJob?.controller.abort();
      activeJob = null;
      unsub();
      ctx.signal?.removeEventListener("abort", cleanup);
    };
    ctx.signal?.addEventListener("abort", cleanup, { once: true });

    const init = async (): Promise<void> => {
      if (destroyed || ctx.signal?.aborted) {
        cleanup();
        return;
      }
      try {
        apiKey = ((await ctx.getSecret("apiKey")) ?? "").trim();
      } catch (err) {
        if (!destroyed) renderVaultError(sanitizeSecretError(err));
        return;
      }
      if (destroyed || ctx.signal?.aborted) {
        cleanup();
        return;
      }
      render();
      if (apiKey) void refresh();
    };

    await init();

    return {
      refresh,
      destroy: cleanup,
    };
  },
};

export default mod;
