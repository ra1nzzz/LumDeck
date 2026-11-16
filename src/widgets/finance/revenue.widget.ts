import { sanitizeSecretError } from "../../core/credentials";
import { fetchJson, HttpError, isAbortError, isHttpError } from "../../core/http";
import type { SettingsBag, WidgetModule } from "../../core/types";
import { icons } from "../icons";

const STRIPE_CHARGES_URL = "https://api.stripe.com/v1/charges";
const DAY_MS = 86_400_000;
const WINDOW_DAYS = 30;
const SPARK_DAYS = 14;
const PAGE_LIMIT = 100;
const MAX_PAGES = 10;
const ROUND_BUDGET_MS = 20_000;
const PER_PAGE_TIMEOUT_MS = 10_000;
const RATE_LIMIT_FALLBACK_MS = 60_000;

type PartialReason = "budget" | "page-limit" | "cursor" | "empty-page" | null;

interface ParsedCharge {
  id: string;
  currency: string;
  created: number;
  net: number;
}

interface CurrencyBucket {
  net: number;
  count: number;
  dayBuckets: Map<number, number>;
}

interface CurrencySummary {
  currency: string;
  net: number;
  count: number;
  days: { label: string; value: number }[];
}

interface TotalsSnapshot {
  byCurrency: Map<string, CurrencySummary>;
  currencies: string[];
  partialReason: PartialReason;
}

const asObj = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const strAt = (o: Record<string, unknown> | null, key: string): string => {
  const v = o ? o[key] : undefined;
  return typeof v === "string" ? v : "";
};

const readCurrencySetting = (s: SettingsBag): string => {
  const raw = typeof s.currency === "string" ? s.currency.trim().toUpperCase() : "";
  return /^[A-Z]{3}$/.test(raw) ? raw : "";
};

/** Number of decimal places a Stripe currency uses (2 for USD/EUR, 0 for JPY, 3 for BHD…). */
const currencyDigits = (code: string): number => {
  try {
    const opts = new Intl.NumberFormat(undefined, { style: "currency", currency: code }).resolvedOptions();
    return typeof opts.maximumFractionDigits === "number" ? opts.maximumFractionDigits : 2;
  } catch {
    return 2;
  }
};

const money = (minor: number, code: string, digits: number): string => {
  const scale = Math.pow(10, digits);
  const major = minor / scale;
  const hasFraction = digits > 0 && minor % scale !== 0;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
      minimumFractionDigits: hasFraction ? digits : 0,
      maximumFractionDigits: digits,
    }).format(major);
  } catch {
    return `${major.toFixed(digits)} ${code}`;
  }
};

const dayKey = (t: number): number => {
  const d = new Date(t);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
};

const dayLabel = (t: number): string =>
  new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });

const parseCharge = (raw: unknown, sinceMs: number): ParsedCharge | null => {
  const c = asObj(raw);
  if (!c) return null;

  const id = strAt(c, "id").trim();
  if (!id) return null;
  if (strAt(c, "status") !== "succeeded") return null;
  if (c.captured === false) return null;

  const createdSec = c.created;
  if (typeof createdSec !== "number" || !Number.isFinite(createdSec) || createdSec <= 0) return null;
  const created = createdSec * 1000;
  if (created < sinceMs) return null;

  const currency = strAt(c, "currency").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return null;

  const captured = c.amount_captured;
  if (typeof captured !== "number" || !Number.isSafeInteger(captured) || captured < 0) return null;

  if (c.amount !== undefined) {
    if (typeof c.amount !== "number" || !Number.isSafeInteger(c.amount) || c.amount < 0) return null;
    if (captured > c.amount) return null;
  }

  const rawRefunded = c.amount_refunded;
  const refunded = rawRefunded === undefined ? 0 : rawRefunded;
  if (typeof refunded !== "number" || !Number.isSafeInteger(refunded) || refunded < 0) return null;
  if (refunded > captured) return null;

  return {
    id,
    currency,
    created,
    net: captured - refunded,
  };
};

const buildChargesUrl = (createdGte: number, startingAfter?: string): string => {
  const base = `${STRIPE_CHARGES_URL}?limit=${PAGE_LIMIT}&created[gte]=${createdGte}`;
  return startingAfter ? `${base}&starting_after=${encodeURIComponent(startingAfter)}` : base;
};

const partialReasonLabel = (reason: Exclude<PartialReason, null>): string => {
  switch (reason) {
    case "budget":
      return "request budget reached";
    case "page-limit":
      return "page limit reached";
    case "cursor":
      return "duplicate or missing cursor";
    case "empty-page":
      return "empty page with more expected";
  }
};

const fetchCharges = async (key: string, signal: AbortSignal): Promise<TotalsSnapshot> => {
  const roundStartMs = Date.now();
  const sinceMs = roundStartMs - WINDOW_DAYS * DAY_MS;
  const createdGte = Math.floor(sinceMs / 1000);

  const seenChargeIds = new Set<string>();
  const seenCursors = new Set<string>();
  const bucketsByCurrency = new Map<string, CurrencyBucket>();

  let cursor: string | undefined;
  let partialReason: PartialReason = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const remainingMs = ROUND_BUDGET_MS - (Date.now() - roundStartMs);
    if (remainingMs <= 0) {
      if (page === 0) {
        throw new HttpError({
          kind: "timeout",
          message: `Request timed out after ${ROUND_BUDGET_MS}ms`,
        });
      }
      partialReason = "budget";
      break;
    }

    const timeoutMs = Math.min(PER_PAGE_TIMEOUT_MS, remainingMs);
    let res;
    try {
      res = await fetchJson<Record<string, unknown>>(buildChargesUrl(createdGte, cursor), {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        signal,
        timeoutMs,
      });
    } catch (err) {
      if (page > 0 && isHttpError(err, "timeout")) {
        partialReason = "budget";
        break;
      }
      throw err;
    }

    const json = !res.noContent ? asObj(res.data) : null;
    if (!json || !Array.isArray(json.data)) {
      throw new HttpError({
        kind: "decode",
        message: "Invalid Stripe charges response",
        status: res.status,
        headers: res.headers,
      });
    }

    const data = json.data;
    for (const raw of data) {
      const charge = parseCharge(raw, sinceMs);
      if (!charge || seenChargeIds.has(charge.id)) continue;
      seenChargeIds.add(charge.id);

      let entry = bucketsByCurrency.get(charge.currency);
      if (!entry) {
        entry = { net: 0, count: 0, dayBuckets: new Map<number, number>() };
        bucketsByCurrency.set(charge.currency, entry);
      }
      entry.net += charge.net;
      entry.count += 1;
      const dk = dayKey(charge.created);
      entry.dayBuckets.set(dk, (entry.dayBuckets.get(dk) ?? 0) + charge.net);
    }

    const hasMore = json.has_more === true;
    if (!hasMore) {
      break;
    }
    if (data.length === 0) {
      partialReason = "empty-page";
      break;
    }

    const nextCursor = strAt(asObj(data[data.length - 1]), "id").trim();
    if (!nextCursor || seenCursors.has(nextCursor)) {
      partialReason = "cursor";
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;

    if (page + 1 >= MAX_PAGES) {
      partialReason = "page-limit";
      break;
    }
  }

  const currencies = [...bucketsByCurrency.keys()].sort((a, b) => a.localeCompare(b));
  const byCurrency = new Map<string, CurrencySummary>();

  for (const code of currencies) {
    const entry = bucketsByCurrency.get(code)!;
    const days: { label: string; value: number }[] = [];
    for (let i = SPARK_DAYS - 1; i >= 0; i--) {
      const t = roundStartMs - i * DAY_MS;
      days.push({ label: dayLabel(t), value: entry.dayBuckets.get(dayKey(t)) ?? 0 });
    }
    byCurrency.set(code, {
      currency: code,
      net: entry.net,
      count: entry.count,
      days,
    });
  }

  return { byCurrency, currencies, partialReason };
};

const mod: WidgetModule = {
  id: "revenue",
  name: "Revenue",
  group: "finance",
  description: "Net captured charges from Stripe",
  icon: icons.trend,
  defaultSize: { w: 3, h: 1 },
  refreshMs: 900000,
  async mount(body, ctx) {
    let key = "";
    let selectedCurrency = readCurrencySetting(ctx.settings);
    let generation = 0;
    let activeJob: {
      key: string;
      gen: number;
      controller: AbortController;
      promise: Promise<void>;
    } | null = null;
    let authRejected = false;
    let retryUntil = 0;
    let lastResult: TotalsSnapshot | null = null;
    let mode: "" | "connect" | "data" | "vault-error" = "";
    let destroyed = false;
    let saving = false;

    body.innerHTML = `
      <div class="w-col" style="height:100%;gap:3px;justify-content:center;min-width:0">
        <div class="w-row" style="gap:6px;min-width:0">
          <span class="w-icon w-good" style="width:15px;height:15px;flex:0 0 auto">${icons.trend}</span>
          <div class="w-title" style="flex:1;min-width:0">Revenue</div>
          <span class="w-faint" data-partial style="font-size:9px;flex:0 0 auto;display:none">Partial</span>
          <div class="w-row" data-currencies style="gap:3px;flex:0 0 auto;display:none"></div>
          <span class="w-faint" data-src style="font-size:9px;flex:0 0 auto">Stripe</span>
        </div>
        <div data-view class="w-col" style="gap:2px;min-width:0">
          <div class="w-big w-mono" data-total
            style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">–</div>
          <div class="w-dim" data-sub style="font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">last 30 days</div>
          <div class="w-bars" data-bars style="height:16px;margin-top:1px"></div>
        </div>
        <div data-connect class="w-col" style="gap:4px">
          <div class="w-dim" style="font-size:10px">Connect a Stripe key to track net captured charges</div>
          <div class="w-row" style="gap:5px">
            <input data-key class="search" type="password" placeholder="sk_live_…" spellcheck="false"
              autocomplete="off" style="margin:0;flex:1;min-width:0;padding:4px 7px;font-size:11px" />
            <button data-save class="w-btn" style="padding:4px 8px;flex:0 0 auto">Save</button>
          </div>
        </div>
        <div data-vault-err class="w-row" style="gap:6px;justify-content:space-between;display:none">
          <span class="w-error" data-vault-msg style="font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
          <button data-retry class="w-btn" style="padding:3px 8px;flex:0 0 auto">Retry</button>
        </div>
        <div class="w-error" data-msg
          style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>
      </div>`;

    const view = body.querySelector<HTMLElement>("[data-view]")!;
    const connect = body.querySelector<HTMLElement>("[data-connect]")!;
    const vaultErr = body.querySelector<HTMLElement>("[data-vault-err]")!;
    const vaultMsg = body.querySelector<HTMLElement>("[data-vault-msg]")!;
    const retryBtn = body.querySelector<HTMLButtonElement>("[data-retry]")!;
    const partialEl = body.querySelector<HTMLElement>("[data-partial]")!;
    const currenciesEl = body.querySelector<HTMLElement>("[data-currencies]")!;
    const totalEl = body.querySelector<HTMLElement>("[data-total]")!;
    const subEl = body.querySelector<HTMLElement>("[data-sub]")!;
    const barsEl = body.querySelector<HTMLElement>("[data-bars]")!;
    const keyIn = body.querySelector<HTMLInputElement>("[data-key]")!;
    const saveBtn = body.querySelector<HTMLButtonElement>("[data-save]")!;
    const msgEl = body.querySelector<HTMLElement>("[data-msg]")!;

    const renderBars = (days: { label: string; value: number }[], code: string, digits: number) => {
      barsEl.innerHTML = "";
      const max = days.reduce((m, d) => Math.max(m, d.value), 0);
      for (const d of days) {
        const bar = document.createElement("i");
        bar.style.height = max > 0 ? `${((d.value / max) * 100).toFixed(1)}%` : "0%";
        bar.title = `${money(d.value, code, digits)} · ${d.label}`;
        barsEl.appendChild(bar);
      }
    };

    const show = (nextMode: "connect" | "data" | "vault-error") => {
      mode = nextMode;
      view.style.display = nextMode === "data" ? "" : "none";
      connect.style.display = nextMode === "connect" ? "" : "none";
      vaultErr.style.display = nextMode === "vault-error" ? "" : "none";
      if (nextMode !== "data") {
        partialEl.style.display = "none";
        currenciesEl.style.display = "none";
      }
    };

    const selectCurrency = (code: string) => {
      if (destroyed || selectedCurrency === code) return;
      selectedCurrency = code;
      ctx.setSettings({ currency: code });
      if (lastResult && mode === "data") {
        renderTotals(lastResult);
      }
    };

    const renderCurrencyButtons = (codes: string[], activeCode: string) => {
      currenciesEl.innerHTML = "";
      const showPicker = codes.length > 1 || (Boolean(activeCode) && codes.length === 1 && codes[0] !== activeCode);
      if (!showPicker) {
        currenciesEl.style.display = "none";
        return;
      }
      currenciesEl.style.display = "";
      for (const code of codes) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "w-btn";
        btn.dataset.currency = code;
        btn.textContent = code;
        const isActive = code === activeCode;
        btn.setAttribute("aria-pressed", isActive ? "true" : "false");
        btn.style.padding = "1px 5px";
        btn.style.fontSize = "9px";
        if (isActive) {
          btn.style.background = "var(--accent)";
          btn.style.color = "#fff";
        }
        btn.addEventListener("click", () => selectCurrency(code));
        currenciesEl.appendChild(btn);
      }
    };

    const renderTotals = (t: TotalsSnapshot) => {
      const partialPrefix = t.partialReason
        ? `partial (${partialReasonLabel(t.partialReason)}) · `
        : "";

      if (t.partialReason) {
        partialEl.style.display = "";
        partialEl.textContent = "Partial";
        partialEl.title = `Partial net charges (${partialReasonLabel(t.partialReason)}) — not a complete financial settlement`;
      } else {
        partialEl.style.display = "none";
        partialEl.title = "";
      }

      const activeCode = selectedCurrency || (t.currencies.length === 1 ? t.currencies[0] : "");
      renderCurrencyButtons(t.currencies, activeCode);

      if (t.currencies.length > 1 && !selectedCurrency) {
        totalEl.textContent = "Select currency";
        totalEl.title = `Multiple currencies (${t.currencies.join(", ")}) — choose one to view its total`;
        subEl.textContent = `${partialPrefix}${t.currencies.length} currencies (${t.currencies.join(", ")}) · choose currency`;
        barsEl.innerHTML = "";
        return;
      }

      if (!activeCode) {
        totalEl.textContent = "–";
        totalEl.title = t.partialReason
          ? `Partial result (${partialReasonLabel(t.partialReason)})`
          : "";
        subEl.textContent = `${partialPrefix}last 30 days · 0 charges`;
        barsEl.innerHTML = "";
        return;
      }

      const summary = t.byCurrency.get(activeCode);
      const digits = currencyDigits(activeCode);
      const net = summary?.net ?? 0;
      const count = summary?.count ?? 0;
      const otherCurrencies = t.currencies.filter((c) => c !== activeCode);
      const otherNote = otherCurrencies.length > 0 ? ` · other: ${otherCurrencies.join(", ")}` : "";

      totalEl.textContent = money(net, activeCode, digits);
      totalEl.title = `${t.partialReason ? `Partial (${partialReasonLabel(t.partialReason)}): ` : ""}${net / Math.pow(10, digits)} ${activeCode} (net captured charges${otherCurrencies.length > 0 ? `; other currencies: ${otherCurrencies.join(", ")}` : ""})`;
      subEl.textContent = `${partialPrefix}${activeCode} · last 30 days · ${count} charge${count === 1 ? "" : "s"}${otherNote}`;

      if (summary) {
        renderBars(summary.days, activeCode, digits);
      } else {
        barsEl.innerHTML = "";
      }
    };

    const fail = (message: string, auth: boolean) => {
      lastResult = null;
      totalEl.textContent = "–";
      totalEl.title = "";
      subEl.textContent = "last 30 days";
      barsEl.innerHTML = "";
      partialEl.style.display = "none";
      currenciesEl.style.display = "none";
      currenciesEl.innerHTML = "";
      msgEl.textContent = message;
      if (auth) {
        if (mode !== "connect") {
          keyIn.value = key;
        }
        show("connect");
      } else {
        show("data");
      }
    };

    const load = (): Promise<void> => {
      if (destroyed) return Promise.resolve();
      const targetKey = key;
      if (!targetKey) {
        lastResult = null;
        msgEl.textContent = "";
        show("connect");
        return Promise.resolve();
      }
      if (authRejected) {
        fail("Stripe rejected that key (401) — check it and save again", true);
        return Promise.resolve();
      }
      if (activeJob && activeJob.key === targetKey) {
        return activeJob.promise;
      }
      if (Date.now() < retryUntil) {
        fail("Stripe rate limited (429) — cooling down", false);
        return Promise.resolve();
      }

      activeJob?.controller.abort();
      const jobGen = ++generation;
      const controller = new AbortController();

      const promise = (async () => {
        try {
          const t = await fetchCharges(targetKey, controller.signal);
          if (destroyed || jobGen !== generation || controller.signal.aborted || key !== targetKey) {
            return;
          }
          retryUntil = 0;
          authRejected = false;
          lastResult = t;
          msgEl.textContent = "";
          show("data");
          renderTotals(t);
        } catch (err) {
          if (isAbortError(err)) return;
          if (destroyed || jobGen !== generation || controller.signal.aborted || key !== targetKey) {
            return;
          }
          if (isHttpError(err, "http")) {
            if (err.status === 401) {
              authRejected = true;
              fail("Stripe rejected that key (401) — check it and save again", true);
              return;
            }
            if (err.status === 403) {
              fail("Stripe permission denied (403) — check key permissions", false);
              return;
            }
            if (err.status === 429) {
              retryUntil = Date.now() + (err.retryAfterMs ?? RATE_LIMIT_FALLBACK_MS);
              fail("Stripe rate limited (429) — cooling down", false);
              return;
            }
            fail(`Stripe error: HTTP ${err.status}`, false);
            return;
          }
          if (isHttpError(err, "timeout")) {
            fail("Stripe request timed out", false);
            return;
          }
          if (isHttpError(err, "decode")) {
            fail("Invalid response from Stripe", false);
            return;
          }
          fail("Can't reach Stripe right now", false);
        } finally {
          if (activeJob?.gen === jobGen) {
            activeJob = null;
          }
        }
      })();

      activeJob = { key: targetKey, gen: jobGen, controller, promise };
      return promise;
    };

    const save = async () => {
      if (saving || destroyed) return;
      const next = keyIn.value.trim();
      if (!next) {
        msgEl.textContent = "Paste a Stripe secret key (sk_…)";
        return;
      }
      saving = true;
      saveBtn.disabled = true;
      msgEl.textContent = "";
      try {
        await ctx.setSecret("apiKey", next);
      } catch (err) {
        if (!destroyed) {
          msgEl.textContent = sanitizeSecretError(err, [next]);
          saveBtn.disabled = false;
        }
        saving = false;
        return;
      }
      saving = false;
      if (destroyed) return;
      const changed = next !== key;
      key = next;
      authRejected = false;
      retryUntil = 0;
      if (changed) {
        lastResult = null;
      }
      generation++;
      activeJob?.controller.abort();
      activeJob = null;
      msgEl.textContent = "";
      saveBtn.disabled = false;
      void load();
    };

    const init = async (): Promise<void> => {
      if (destroyed || ctx.signal?.aborted) {
        cleanup();
        return;
      }
      try {
        key = ((await ctx.getSecret("apiKey")) ?? "").trim();
      } catch (err) {
        if (!destroyed) {
          vaultMsg.textContent = sanitizeSecretError(err);
          msgEl.textContent = "";
          show("vault-error");
        }
        return;
      }
      if (destroyed || ctx.signal?.aborted) {
        cleanup();
        return;
      }
      if (key) {
        show("data");
        void load();
      } else {
        show("connect");
      }
    };

    const offSettings = ctx.onSettings((s) => {
      if (destroyed) return;
      const nextCurrency = readCurrencySetting(s);
      if (nextCurrency === selectedCurrency) return;
      selectedCurrency = nextCurrency;
      if (lastResult && mode === "data") {
        renderTotals(lastResult);
      }
    });

    const cleanup = () => {
      if (destroyed) return;
      destroyed = true;
      generation++;
      activeJob?.controller.abort();
      activeJob = null;
      offSettings();
      ctx.signal?.removeEventListener("abort", cleanup);
    };
    ctx.signal?.addEventListener("abort", cleanup, { once: true });

    saveBtn.addEventListener("click", () => {
      void save();
    });
    keyIn.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") void save();
    });
    retryBtn.addEventListener("click", () => {
      void init();
    });

    await init();

    return {
      refresh: () => load(),
      destroy: cleanup,
    };
  },
};

export default mod;
