import type { WidgetModule } from "../../core/types";
import { icons } from "../icons";

// Inline transport glyphs (icons.ts has no skip-back / skip-forward).
const PREV =
  '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M6 5h2.4v14H6z"/><path d="M20 5v14l-11.2-7z"/></svg>';
const NEXT =
  '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M15.6 5H18v14h-2.4z"/><path d="M4 5v14l11.2-7z"/></svg>';

interface Track {
  title: string;
  artist: string;
  source: string;
  playing: boolean;
}

type State =
  | { kind: "track"; track: Track }
  | { kind: "empty" }
  | { kind: "error" }
  | { kind: "unavailable" };

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const bool = (v: unknown): boolean => v === true;

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : String(e));

/** True when the invoke rejected because the command isn't registered in this build. */
const isCommandMissing = (e: unknown): boolean => {
  const msg = errText(e).toLowerCase();
  return (
    msg.includes("not found") ||
    msg.includes("now_playing") ||
    msg.includes("media_control")
  );
};

function setText(el: HTMLElement, text: string): void {
  el.textContent = text;
  if (text) el.title = text;
  else el.removeAttribute("title");
}

const mod: WidgetModule = {
  id: "now-playing",
  name: "Now Playing",
  group: "media",
  description: "Current track and transport controls",
  icon: icons.music,
  defaultSize: { w: 3, h: 1 },
  refreshMs: 3000,
  mount(body, ctx) {
    body.innerHTML = `
      <div data-view="off" class="w-row" style="gap:8px;height:100%">
        <div class="w-icon" style="width:20px;height:20px;color:var(--text-dim)">${icons.music}</div>
        <div class="w-col" style="gap:1px;min-width:0">
          <div class="w-dim" style="font-size:12px" data-main>Nothing playing</div>
          <div class="w-faint" data-sub style="font-size:10px"></div>
        </div>
      </div>
      <div data-view="on" class="w-row" style="display:none;gap:8px;height:100%">
        <div class="w-col" style="flex:1;min-width:0;gap:1px">
          <div class="w-value" data-title style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>
          <div class="w-dim" data-artist style="font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>
          <div class="w-faint" data-source style="font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>
        </div>
        <div data-eq class="np-eq" style="display:none"><i></i><i></i><i></i><i></i></div>
        <div class="w-row" style="gap:4px">
          <button class="w-btn np-btn" data-prev title="Previous" aria-label="Previous">${PREV}</button>
          <button class="w-btn np-btn" data-toggle title="Play / Pause" aria-label="Play or pause"></button>
          <button class="w-btn np-btn" data-next title="Next" aria-label="Next">${NEXT}</button>
        </div>
      </div>`;

    const styleEl = document.createElement("style");
    styleEl.textContent = `
      .np-btn { width:26px; height:24px; padding:0; display:inline-flex; align-items:center; justify-content:center; }
      .np-btn svg { width:12px; height:12px; display:block; }
      .np-eq { display:flex; align-items:flex-end; gap:2px; height:16px; }
      .np-eq i { width:3px; height:100%; border-radius:1px; background:var(--accent); transform-origin:bottom; opacity:.9; }`;
    body.appendChild(styleEl);

    const offView = body.querySelector<HTMLElement>('[data-view="off"]')!;
    const onView = body.querySelector<HTMLElement>('[data-view="on"]')!;
    const sub = body.querySelector<HTMLElement>("[data-sub]")!;
    const mainEl = body.querySelector<HTMLElement>("[data-main]")!;
    const titleEl = body.querySelector<HTMLElement>("[data-title]")!;
    const artistEl = body.querySelector<HTMLElement>("[data-artist]")!;
    const sourceEl = body.querySelector<HTMLElement>("[data-source]")!;
    const eq = body.querySelector<HTMLElement>("[data-eq]")!;
    const toggleBtn = body.querySelector<HTMLButtonElement>("[data-toggle]")!;
    const prevBtn = body.querySelector<HTMLButtonElement>("[data-prev]")!;
    const nextBtn = body.querySelector<HTMLButtonElement>("[data-next]")!;

    const anims = [...eq.querySelectorAll<HTMLElement>("i")].map((bar, i) =>
      bar.animate(
        [
          { transform: "scaleY(0.25)" },
          { transform: "scaleY(1)" },
          { transform: "scaleY(0.25)" },
        ],
        {
          duration: 620 + i * 130,
          delay: i * 110,
          iterations: Infinity,
          easing: "ease-in-out",
        },
      ),
    );

    const render = (state: State) => {
      if (state.kind === "track") {
        const t = state.track;
        offView.style.display = "none";
        onView.style.display = "flex";
        setText(titleEl, t.title || "Unknown title");
        setText(artistEl, t.artist || "–");
        setText(sourceEl, t.source);
        sourceEl.style.display = t.source ? "" : "none";
        eq.style.display = t.playing ? "flex" : "none";
        toggleBtn.innerHTML = t.playing ? icons.pause : icons.play;
      } else {
        onView.style.display = "none";
        offView.style.display = "flex";
        if (state.kind === "unavailable") {
          setText(mainEl, "Now Playing · not available in this build");
          setText(sub, "The backend command isn't wired up in this build.");
        } else {
          setText(mainEl, "Nothing playing");
          setText(sub, state.kind === "error" ? "unavailable" : "");
        }
      }
    };

    const flash = (el: HTMLElement) => {
      el.animate(
        [
          { color: "var(--bad)" },
          { color: "var(--bad)", offset: 0.6 },
          { color: "var(--text)" },
        ],
        { duration: 900, easing: "ease-out" },
      );
    };

    const refresh = async () => {
      try {
        const raw = await ctx.invoke<Track | null>("now_playing");
        if (!raw) {
          render({ kind: "empty" });
          return;
        }
        const title = str(raw.title);
        const artist = str(raw.artist);
        if (!title && !artist) {
          render({ kind: "empty" });
          return;
        }
        render({
          kind: "track",
          track: { title, artist, source: str(raw.source), playing: bool(raw.playing) },
        });
      } catch (e) {
        render(isCommandMissing(e) ? { kind: "unavailable" } : { kind: "error" });
      }
    };

    const control = async (action: "prev" | "toggle" | "next", btn: HTMLButtonElement) => {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.style.opacity = "0.55";
      try {
        await ctx.invoke("media_control", { action });
        void refresh();
      } catch {
        flash(btn);
      } finally {
        btn.disabled = false;
        btn.style.opacity = "";
      }
    };

    prevBtn.addEventListener("click", () => void control("prev", prevBtn));
    toggleBtn.addEventListener("click", () => void control("toggle", toggleBtn));
    nextBtn.addEventListener("click", () => void control("next", nextBtn));

    void refresh();
    return {
      refresh,
      destroy() {
        for (const a of anims) a.cancel();
        styleEl.remove();
      },
    };
  },
};

export default mod;
