import type { WidgetModule } from "../../core/types";
import { icons } from "../icons";

type ProviderId = "claude" | "chatgpt" | "gemini" | "grok" | "deepseek" | "glm";

interface ProviderDef {
  id: ProviderId;
  label: string;
  short: string;
  color: string;
}

const PROVIDERS: readonly ProviderDef[] = [
  { id: "claude", label: "Claude", short: "Claude", color: "#d97757" },
  { id: "chatgpt", label: "ChatGPT", short: "GPT", color: "#19c37d" },
  { id: "gemini", label: "Gemini", short: "Gemini", color: "#4b8efb" },
  { id: "grok", label: "Grok", short: "Grok", color: "#b9c0cb" },
  { id: "deepseek", label: "DeepSeek", short: "DS", color: "#4d6bfe" },
  { id: "glm", label: "GLM", short: "GLM", color: "#7c5cff" },
];

const WINDOW_KEYS = {
  session: ["session", "session_usage", "sessionUsage", "five_hour", "fiveHour", "current", "primary"],
  weekly: ["weekly", "weekly_usage", "weeklyUsage", "week", "seven_day", "sevenDay", "secondary"],
} as const;

const isProvider = (v: unknown): v is ProviderId =>
  typeof v === "string" && PROVIDERS.some((p) => p.id === v);

const asString = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const asNum = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(/[^\d.-]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return null;
};

const clamp = (n: number): number => Math.max(0, Math.min(100, n));

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

const pick = (o: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => {
  for (const k of keys) {
    const v = rec(o[k]);
    if (Object.keys(v).length) return v;
  }
  return {};
};

const percentOf = (w: Record<string, unknown>): number | null => {
  const direct = asNum(w.percent ?? w.percentage ?? w.used_percent ?? w.usedPercent ?? w.utilization);
  if (direct != null) return clamp(direct);
  const used = asNum(w.used);
  const limit = asNum(w.limit ?? w.total ?? w.quota);
  if (used != null && limit != null && limit > 0) return clamp((used / limit) * 100);
  return null;
};

const shortNum = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

const subOf = (w: Record<string, unknown>): string => {
  const reset = asString(w.resets_at ?? w.resetsAt ?? w.resets_in ?? w.resetsIn ?? w.reset);
  if (reset) return `resets ${reset}`;
  const used = asNum(w.used);
  const limit = asNum(w.limit ?? w.total ?? w.quota);
  if (used != null && limit != null) return `${shortNum(used)} / ${shortNum(limit)} used`;
  return "";
};

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : String(e));

/** True when the invoke rejected because the `ai_usage` command isn't registered in this build. */
const isCommandMissing = (e: unknown): boolean => {
  const msg = errText(e).toLowerCase();
  return msg.includes("not found") || msg.includes("ai_usage");
};

const mod: WidgetModule = {
  id: "ai-usage",
  name: "AI Usage",
  group: "ai",
  description: "Plan usage for Claude, ChatGPT, Gemini, Grok, DeepSeek and GLM",
  icon: icons.spark,
  defaultSize: { w: 3, h: 1 },
  refreshMs: 60000,
  async mount(body, ctx) {
    let provider: ProviderId = isProvider(ctx.settings.provider) ? ctx.settings.provider : "claude";
    let view: "main" | "connect" | "unavailable" = "main";
    let busy = false;
    let note = "";

    const def = (): ProviderDef => PROVIDERS.find((p) => p.id === provider) ?? PROVIDERS[0];
    const sessionKey = (): string => asString(ctx.settings.sessionKey);
    const connected = (): boolean => ctx.settings.connected === true;

    const windowRowHtml = (key: string, label: string): string => `
      <div class="w-col" style="gap:3px">
        <div class="w-row" style="justify-content:space-between">
          <span class="w-title">${label}</span>
          <span class="w-mono w-faint" style="font-size:11px;font-weight:650" data-pct="${key}">–</span>
        </div>
        <div style="height:6px;border-radius:3px;background:var(--track);overflow:hidden">
          <div data-bar="${key}" style="height:100%;width:0%;border-radius:3px;background:var(--p)"></div>
        </div>
        <div class="w-faint" style="font-size:10px" data-sub="${key}">&nbsp;</div>
      </div>`;

    const layoutHtml = (): string => `
      <div class="w-col" style="gap:6px;height:100%;justify-content:center">
        <div class="w-row" style="gap:6px">
          <span class="w-icon" style="width:15px;height:15px;color:var(--p)">${icons.spark}</span>
          <span class="w-title" style="font-weight:650" data-plan>${def().label}</span>
          <span class="w-spacer"></span>
          <button class="w-btn" data-refresh style="padding:2px 6px;background:transparent;color:var(--text-faint)" title="Refresh">↻</button>
        </div>
        <div data-content class="w-col" style="gap:7px"></div>
        <div class="w-row" style="gap:4px" data-chips></div>
      </div>`;

    const mainHtml = (): string => `
      ${windowRowHtml("session", "Session")}
      ${windowRowHtml("weekly", "Weekly")}
      <div class="w-faint" style="font-size:10px" data-most>&nbsp;</div>`;

    const connectHtml = (): string => `
      <div class="w-col" style="gap:5px">
        <span class="w-title" style="font-weight:650">Connect your ${def().label} account</span>
        <span class="w-faint" style="font-size:10px;line-height:1.35">Reads your own sign-in, read-only — usage never leaves this machine.</span>
        <div class="w-row" style="gap:5px">
          <input data-token class="search" style="margin:0;padding:4px 7px;font-size:11px;flex:1" type="password" placeholder="Session key (optional)" />
          <button class="w-btn" data-connect style="padding:4px 9px">Connect</button>
        </div>
        ${note ? `<div class="w-error">${escapeHtml(note)}</div>` : ""}
      </div>`;

    const unavailableHtml = (): string => `
      <div class="w-col" style="gap:5px">
        <span class="w-title" style="font-weight:650">AI Usage · not available in this build</span>
        <span class="w-faint" style="font-size:10px;line-height:1.35">The backend command isn't wired up yet — usage can't be read.</span>
        ${note ? `<div class="w-error">${escapeHtml(note)}</div>` : ""}
      </div>`;

    const renderChips = (): void => {
      const wrap = body.querySelector<HTMLElement>("[data-chips]");
      if (!wrap) return;
      wrap.innerHTML = "";
      for (const p of PROVIDERS) {
        const chip = document.createElement("button");
        const active = p.id === provider;
        chip.className = "w-btn";
        chip.textContent = p.short;
        chip.title = p.label;
        chip.style.cssText = [
          "padding:2px 6px",
          "font-size:10px",
          `background:${active ? p.color : "transparent"}`,
          `color:${active ? "#0b0e14" : "var(--text-dim)"}`,
          `border:1px solid ${active ? "transparent" : "var(--tile-border)"}`,
        ].join(";");
        chip.addEventListener("click", () => {
          if (p.id === provider) return;
          provider = p.id;
          ctx.setSettings({ provider: p.id });
          render();
          void refresh();
        });
        wrap.appendChild(chip);
      }
    };

    const paintWindow = (key: string, w: Record<string, unknown>): void => {
      const pctEl = body.querySelector<HTMLElement>(`[data-pct="${key}"]`);
      const barEl = body.querySelector<HTMLElement>(`[data-bar="${key}"]`);
      const subEl = body.querySelector<HTMLElement>(`[data-sub="${key}"]`);
      if (!pctEl || !barEl || !subEl) return;
      const pct = percentOf(w);
      if (pct == null) {
        pctEl.textContent = "–";
        pctEl.className = "w-mono w-faint";
        pctEl.style.fontSize = "11px";
        pctEl.style.fontWeight = "650";
        barEl.style.width = "0%";
        subEl.textContent = "unavailable";
        return;
      }
      const rounded = Math.round(pct);
      const tone = rounded >= 90 ? "w-bad" : rounded >= 75 ? "w-warn" : "w-good";
      pctEl.textContent = `${rounded}%`;
      pctEl.className = `w-mono ${tone}`;
      pctEl.style.fontSize = "11px";
      pctEl.style.fontWeight = "650";
      barEl.style.width = `${rounded}%`;
      barEl.style.background = rounded >= 90 ? "var(--bad)" : rounded >= 75 ? "var(--warn)" : "var(--p)";
      const sub = subOf(w);
      subEl.textContent = sub || "\u00a0";
    };

    const paintPending = (): void => {
      for (const key of ["session", "weekly"]) {
        const pctEl = body.querySelector<HTMLElement>(`[data-pct="${key}"]`);
        if (pctEl) {
          pctEl.textContent = "…";
          pctEl.className = "w-mono w-faint";
        }
      }
    };

    const render = (): void => {
      body.style.setProperty("--p", def().color);
      body.innerHTML = layoutHtml();
      renderChips();
      const content = body.querySelector<HTMLElement>("[data-content]");
      if (content) {
        content.innerHTML =
          view === "connect"
            ? connectHtml()
            : view === "unavailable"
              ? unavailableHtml()
              : mainHtml();
      }
      if (view === "connect") {
        const input = body.querySelector<HTMLInputElement>("[data-token]");
        const connect = body.querySelector<HTMLButtonElement>("[data-connect]");
        const save = () => {
          const patch: Record<string, unknown> = { connected: true };
          const key = input?.value.trim() ?? "";
          if (key) patch.sessionKey = key;
          ctx.setSettings(patch);
          view = "main";
          render();
          void refresh();
        };
        connect?.addEventListener("click", save);
        input?.addEventListener("keydown", (e) => {
          if (e.key === "Enter") save();
        });
      } else {
        paintPending();
      }
      body.querySelector<HTMLButtonElement>("[data-refresh]")?.addEventListener("click", () => {
        void refresh();
      });
    };

    const refresh = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      paintPending();
      try {
        const args: Record<string, unknown> = { provider };
        const key = sessionKey();
        if (key) args.sessionKey = key;
        const raw = await ctx.invoke<unknown>("ai_usage", args);
        const data = rec(raw);
        if (!Object.keys(data).length) throw new Error("no usage data");
        view = "main";
        render();
        paintWindow("session", pick(data, WINDOW_KEYS.session));
        paintWindow("weekly", pick(data, WINDOW_KEYS.weekly));
        const plan = asString(data.plan ?? data.tier ?? data.subscription);
        const planEl = body.querySelector<HTMLElement>("[data-plan]");
        if (planEl) planEl.textContent = plan ? `${def().label} · ${plan}` : def().label;
        const most = asString(data.most_used ?? data.mostUsed ?? data.top_model ?? data.topModel ?? data.model);
        const mostEl = body.querySelector<HTMLElement>("[data-most]");
        if (mostEl) mostEl.textContent = most ? `most used: ${most}` : "\u00a0";
        note = "";
      } catch (e) {
        note = errText(e);
        if (isCommandMissing(e)) {
          view = "unavailable";
          render();
        } else if (connected()) {
          view = "main";
          render();
          paintWindow("session", {});
          paintWindow("weekly", {});
          for (const key of ["session", "weekly"]) {
            const subEl = body.querySelector<HTMLElement>(`[data-sub="${key}"]`);
            if (subEl) subEl.textContent = "connect to read usage";
          }
          const mostEl = body.querySelector<HTMLElement>("[data-most]");
          if (mostEl) mostEl.textContent = note ? `unavailable · ${note}` : "\u00a0";
        } else {
          view = "connect";
          render();
        }
      } finally {
        busy = false;
      }
    };

    const offSettings = ctx.onSettings((s) => {
      const next = isProvider(s.provider) ? s.provider : "claude";
      if (next === provider) return;
      provider = next;
      render();
      void refresh();
    });

    render();
    await refresh();

    return { refresh, destroy: () => offSettings() };
  },
};

export default mod;
