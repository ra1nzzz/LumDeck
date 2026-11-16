import type { WidgetModule } from "../../core/types";
import { icons } from "../icons";

const CHARGES_URL = "https://api.stripe.com/v1/charges?limit=100";
const DAY_MS = 86400000;
const WINDOW_DAYS = 30;
const SPARK_DAYS = 14;

interface Charge {
  amount: number;
  currency: string;
  created: number;
  refunded: number;
}

interface Totals {
  net: number;
  currency: string;
  days: { label: string; value: number }[];
  count: number;
  hasMore: boolean;
}

const asObj = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const numAt = (o: Record<string, unknown> | null, key: string, fallback = 0): number => {
  const v = o ? o[key] : undefined;
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
};

const strAt = (o: Record<string, unknown> | null, key: string): string => {
  const v = o ? o[key] : undefined;
  return typeof v === "string" ? v : "";
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
  const major = minor / Math.pow(10, digits);
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
      minimumFractionDigits: 0,
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

const fetchCharges = async (key: string, signal?: AbortSignal): Promise<Totals> => {
  let res: Response;
  try {
    res = await fetchTimeout(
      CHARGES_URL,
      { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal },
      15000,
    );
  } catch {
    throw new Error("offline");
  }
  if (res.status === 401 || res.status === 403) throw new Error("auth");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = asObj(await res.json());
  const data = asArray(json && json.data);
  const hasMore = json?.has_more === true;

  const since = Date.now() - WINDOW_DAYS * DAY_MS;
  const charges: Charge[] = [];
  for (const raw of data) {
    const c = asObj(raw);
    if (!c || strAt(c, "status") !== "succeeded") continue;
    const created = numAt(c, "created", 0) * 1000;
    if (created < since) continue;
    charges.push({
      amount: numAt(c, "amount", 0),
      currency: strAt(c, "currency").toUpperCase(),
      created,
      refunded: numAt(c, "amount_refunded", 0),
    });
  }

  // Currency-aware: keep only the dominant currency so the sum stays comparable.
  const perCurrency = new Map<string, number>();
  for (const c of charges) {
    const net = Math.max(0, c.amount - c.refunded);
    perCurrency.set(c.currency, (perCurrency.get(c.currency) ?? 0) + net);
  }
  let currency = "";
  let net = 0;
  for (const [code, total] of perCurrency) {
    if (total > net || currency === "") {
      currency = code;
      net = total;
    }
  }

  const buckets = new Map<number, number>();
  for (const c of charges) {
    if (c.currency !== currency) continue;
    const netMinor = Math.max(0, c.amount - c.refunded);
    const k = dayKey(c.created);
    buckets.set(k, (buckets.get(k) ?? 0) + netMinor);
  }

  const days: { label: string; value: number }[] = [];
  for (let i = SPARK_DAYS - 1; i >= 0; i--) {
    const t = Date.now() - i * DAY_MS;
    days.push({ label: dayLabel(t), value: buckets.get(dayKey(t)) ?? 0 });
  }

  const included = charges.filter((c) => c.currency === currency).length;
  return { net, currency, days, count: included, hasMore };
};

const mod: WidgetModule = {
  id: "revenue",
  name: "Revenue",
  group: "finance",
  description: "Net revenue from Stripe charges",
  icon: icons.trend,
  defaultSize: { w: 3, h: 1 },
  refreshMs: 900000,
  mount(body, ctx) {
    let key = typeof ctx.settings.apiKey === "string" ? ctx.settings.apiKey.trim() : "";
    let gen = 0;
    let inFlight = false;
    let queued = false;
    let destroyed = false;
    let ac: AbortController | null = null;

    body.innerHTML = `
      <div class="w-col" style="height:100%;gap:3px;justify-content:center;min-width:0">
        <div class="w-row" style="gap:6px;min-width:0">
          <span class="w-icon w-good" style="width:15px;height:15px;flex:0 0 auto">${icons.trend}</span>
          <div class="w-title" style="flex:1;min-width:0">Revenue</div>
          <span class="w-faint" data-src style="font-size:9px;flex:0 0 auto">Stripe</span>
        </div>
        <div data-view class="w-col" style="gap:2px;min-width:0">
          <div class="w-big w-mono" data-total
            style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">–</div>
          <div class="w-dim" data-sub style="font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">last 30 days</div>
          <div class="w-bars" data-bars style="height:16px;margin-top:1px"></div>
        </div>
        <div data-connect class="w-col" style="gap:4px">
          <div class="w-dim" style="font-size:10px">Connect a Stripe key to track net revenue</div>
          <div class="w-row" style="gap:5px">
            <input data-key class="search" type="password" placeholder="sk_live_…" spellcheck="false"
              autocomplete="off" style="margin:0;flex:1;min-width:0;padding:4px 7px;font-size:11px" />
            <button data-save class="w-btn" style="padding:4px 8px;flex:0 0 auto">Save</button>
          </div>
        </div>
        <div class="w-error" data-msg
          style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>
      </div>`;

    const view = body.querySelector<HTMLElement>("[data-view]")!;
    const connect = body.querySelector<HTMLElement>("[data-connect]")!;
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

    const show = (mode: "connect" | "data") => {
      view.style.display = mode === "data" ? "" : "none";
      connect.style.display = mode === "connect" ? "" : "none";
    };

    const fail = (message: string, auth: boolean) => {
      totalEl.textContent = "–";
      subEl.textContent = "last 30 days";
      barsEl.innerHTML = "";
      msgEl.textContent = message;
      if (auth) {
        keyIn.value = key;
        show("connect");
      } else {
        show("data");
      }
    };

    const load = async () => {
      if (destroyed) return;
      const myGen = ++gen;
      if (inFlight) {
        queued = true;
        return;
      }
      if (!key) {
        msgEl.textContent = "";
        show("connect");
        return;
      }
      inFlight = true;
      ac?.abort();
      const ctrl = new AbortController();
      ac = ctrl;
      try {
        const t = await fetchCharges(key, ctrl.signal);
        if (!destroyed && myGen === gen) {
          const digits = currencyDigits(t.currency || "USD");
          const code = t.currency || "USD";
          totalEl.textContent = money(t.net, code, digits);
          totalEl.title = `${t.net / Math.pow(10, digits)} ${code}`;
          subEl.textContent = `last 30 days · ${t.count} charge${t.count === 1 ? "" : "s"}${t.hasMore ? " +" : ""}`;
          renderBars(t.days, code, digits);
          msgEl.textContent = "";
          show("data");
        }
      } catch (err) {
        if (!destroyed && myGen === gen) {
          const m = err instanceof Error ? err.message : "offline";
          if (m === "auth") fail("Stripe rejected that key — check it and save again", true);
          else if (m === "offline") fail("Can't reach Stripe right now", false);
          else fail(`Stripe error: ${m}`, false);
        }
      } finally {
        inFlight = false;
      }
      if (queued && !destroyed) {
        queued = false;
        void load();
      }
    };

    const save = () => {
      const next = keyIn.value.trim();
      if (!next) {
        msgEl.textContent = "Paste a Stripe secret key (sk_…)";
        return;
      }
      key = next;
      ctx.setSettings({ apiKey: next });
      msgEl.textContent = "";
      void load();
    };

    saveBtn.addEventListener("click", save);
    keyIn.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") save();
    });

    const off = ctx.onSettings((s) => {
      const next = typeof s.apiKey === "string" ? s.apiKey.trim() : "";
      if (next === key) return;
      key = next;
      if (!key) {
        msgEl.textContent = "";
        show("connect");
      } else {
        void load();
      }
    });

    if (key) {
      show("data");
      void load();
    } else {
      show("connect");
    }

    return {
      refresh: () => load(),
      destroy: () => {
        destroyed = true;
        ac?.abort();
        ac = null;
        off();
      },
    };
  },
};

export default mod;
