import type { WidgetModule } from "../../core/types";
import { icons } from "../icons";

const CODE_RE = /^[A-Za-z]{3}$/;

const asObj = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;

const numAt = (o: Record<string, unknown> | null, key: string): number | null => {
  const v = o ? o[key] : undefined;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

const strAt = (o: Record<string, unknown> | null, key: string): string => {
  const v = o ? o[key] : undefined;
  return typeof v === "string" ? v : "";
};

const readCode = (v: unknown, fallback: string): string =>
  typeof v === "string" && CODE_RE.test(v.trim()) ? v.trim().toUpperCase() : fallback;

const readAmount = (v: unknown, fallback: number): number => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim());
    if (Number.isFinite(n)) return n;
  }
  return fallback;
};

const fmt = (n: number): string => {
  const digits = n !== 0 && Math.abs(n) < 1 ? 4 : 2;
  try {
    return n.toLocaleString(undefined, { maximumFractionDigits: digits });
  } catch {
    return n.toFixed(digits);
  }
};

const clock = (d: Date): string =>
  d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

interface Quote {
  rate: number;
}

/** Tries a couple of free CORS-friendly FX hosts; resolves with the unit rate. */
const friendly = (raw: string): string => {
  if (/^HTTP 4\d\d$/.test(raw)) return "check currency codes";
  if (raw === "timeout") return "timed out";
  if (raw === "no rate") return "no rate for that pair";
  return raw;
};

const fetchRate = async (from: string, to: string): Promise<Quote> => {
  const sources: { url: string; pick: (j: Record<string, unknown> | null) => number | null }[] = [
    {
      url: `https://api.frankfurter.app/latest?from=${from}&to=${to}`,
      pick: (j) => numAt(asObj(j && j.rates), to),
    },
    {
      url: `https://api.frankfurter.dev/v1/latest?from=${from}&to=${to}`,
      pick: (j) => numAt(asObj(j && j.rates), to),
    },
    {
      url: `https://open.er-api.com/v6/latest/${from}`,
      pick: (j) => (strAt(j, "result") === "success" ? numAt(asObj(j && j.rates), to) : null),
    },
  ];

  let lastErr = "offline";
  for (const src of sources) {
    const ctl = new AbortController();
    const timer = window.setTimeout(() => ctl.abort(), 10000);
    try {
      const res = await fetch(src.url, {
        signal: ctl.signal,
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        continue;
      }
      const json: unknown = await res.json();
      const rate = src.pick(asObj(json));
      if (rate !== null && rate > 0) return { rate };
      lastErr = "no rate";
    } catch (err) {
      lastErr = err instanceof Error && err.name === "AbortError" ? "timeout" : "offline";
    } finally {
      window.clearTimeout(timer);
    }
  }
  throw new Error(friendly(lastErr));
};

const mod: WidgetModule = {
  id: "currency",
  name: "Currency",
  group: "finance",
  description: "Live FX conversion between two currencies",
  icon: icons.cash,
  defaultSize: { w: 2, h: 1 },
  refreshMs: 3600000,
  mount(body, ctx) {
    let from = readCode(ctx.settings.from, "USD");
    let to = readCode(ctx.settings.to, "JPY");
    let amount = readAmount(ctx.settings.amount, 1);
    let rate: number | null = null;
    let stamp = "";
    let note = "";
    let gen = 0;
    let inFlight = false;
    let queued = false;
    let destroyed = false;

    body.innerHTML = `
      <div class="w-col" style="height:100%;gap:3px;justify-content:center;min-width:0">
        <div class="w-row" style="gap:6px;min-width:0">
          <button data-refresh class="w-btn" title="Refresh rate"
            style="padding:2px;background:transparent;color:var(--accent);flex:0 0 auto">
            <span class="w-icon" style="width:15px;height:15px">${icons.cash}</span>
          </button>
          <div class="w-value w-mono" data-out
            style="flex:1;min-width:0;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">–</div>
        </div>
        <div class="w-dim" data-note style="font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">rate –</div>
        <div class="w-row" style="gap:3px">
          <input data-amt class="search" inputmode="decimal" placeholder="1" title="Amount"
            style="margin:0;flex:0 0 32px;width:32px;min-width:0;padding:3px 4px;font-size:10px;text-align:right" />
          <input data-from class="search" maxlength="3" placeholder="USD" title="From"
            style="margin:0;flex:1 1 0;width:auto;min-width:0;padding:3px 4px;font-size:10px;text-transform:uppercase" />
          <span class="w-faint" style="font-size:9px;flex:0 0 auto">→</span>
          <input data-to class="search" maxlength="3" placeholder="JPY" title="To"
            style="margin:0;flex:1 1 0;width:auto;min-width:0;padding:3px 4px;font-size:10px;text-transform:uppercase" />
        </div>
      </div>`;

    const out = body.querySelector<HTMLElement>("[data-out]")!;
    const noteEl = body.querySelector<HTMLElement>("[data-note]")!;
    const amtIn = body.querySelector<HTMLInputElement>("[data-amt]")!;
    const fromIn = body.querySelector<HTMLInputElement>("[data-from]")!;
    const toIn = body.querySelector<HTMLInputElement>("[data-to]")!;
    const refreshBtn = body.querySelector<HTMLButtonElement>("[data-refresh]")!;

    amtIn.value = String(amount);
    fromIn.value = from;
    toIn.value = to;

    const render = () => {
      if (rate === null) {
        out.textContent = "–";
      } else {
        out.textContent = `${fmt(amount)} ${from} = ${fmt(amount * rate)} ${to}`;
      }
      noteEl.textContent = rate === null ? (note || "rate –") : `rate ${fmt(rate)} · ${stamp}`;
      noteEl.style.color = rate === null && note ? "var(--warn)" : "";
    };

    const load = async () => {
      if (destroyed) return;
      const myGen = ++gen;
      if (inFlight) {
        queued = true;
        return;
      }
      inFlight = true;
      note = "";
      let fresh = false;
      try {
        const quote = await fetchRate(from, to);
        if (!destroyed && myGen === gen) {
          rate = quote.rate;
          stamp = clock(new Date());
          fresh = true;
        }
      } catch (err) {
        if (!destroyed && myGen === gen) {
          rate = null;
          stamp = "";
          note = err instanceof Error && err.message ? err.message : "offline";
          fresh = true;
        }
      } finally {
        inFlight = false;
      }
      if (fresh) render();
      if (queued && !destroyed) {
        queued = false;
        void load();
      }
    };

    /** A new pair invalidates the cached rate so it can never be reused for another pair. */
    const invalidate = () => {
      gen++;
      rate = null;
      stamp = "";
      note = "";
      render();
      void load();
    };

    const onAmountInput = () => {
      const raw = amtIn.value.trim();
      if (raw === "") return;
      const n = Number(raw);
      if (Number.isFinite(n)) {
        amount = n;
        render();
      }
    };

    const onPairInput = () => {
      const f = readCode(fromIn.value, from);
      const t = readCode(toIn.value, to);
      if (f === from && t === to) return;
      from = f;
      to = t;
      invalidate();
    };

    const commit = () => {
      const f = readCode(fromIn.value, from);
      const t = readCode(toIn.value, to);
      fromIn.value = f;
      toIn.value = t;
      const rawAmount = amtIn.value.trim();
      const pairChanged = f !== from || t !== to;
      from = f;
      to = t;
      if (rawAmount !== "") {
        const n = Number(rawAmount);
        if (Number.isFinite(n)) amount = n;
      }
      ctx.setSettings({ from, to, amount });
      if (pairChanged) {
        invalidate();
      } else {
        render();
      }
    };

    amtIn.addEventListener("input", onAmountInput);
    fromIn.addEventListener("input", onPairInput);
    toIn.addEventListener("input", onPairInput);
    amtIn.addEventListener("change", commit);
    fromIn.addEventListener("change", commit);
    toIn.addEventListener("change", commit);
    [amtIn, fromIn, toIn].forEach((el) =>
      el.addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key === "Enter") commit();
      }),
    );
    refreshBtn.addEventListener("click", () => void load());

    const off = ctx.onSettings((s) => {
      const f = readCode(s.from, from);
      const t = readCode(s.to, to);
      const a = readAmount(s.amount, amount);
      const changed = f !== from || t !== to || a !== amount;
      from = f;
      to = t;
      amount = a;
      if (document.activeElement !== amtIn) amtIn.value = String(amount);
      if (document.activeElement !== fromIn) fromIn.value = from;
      if (document.activeElement !== toIn) toIn.value = to;
      if (changed) {
        invalidate();
      }
    });

    render();
    void load();

    return {
      refresh: () => load(),
      destroy: () => {
        destroyed = true;
        off();
      },
    };
  },
};

export default mod;
