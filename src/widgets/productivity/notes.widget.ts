import type { WidgetModule } from "../../core/types";
import { icons } from "../icons";

const mod: WidgetModule = {
  id: "notes",
  name: "Notes",
  group: "productivity",
  description: "A scratchpad that saves itself",
  icon: icons.note,
  defaultSize: { w: 2, h: 2 },
  mount(body, ctx) {
    const initial = typeof ctx.settings.text === "string" ? ctx.settings.text : "";

    body.innerHTML = `
      <div class="w-row w-title" style="justify-content:space-between">
        <span>Notes</span>
        <span data-hint class="w-faint" style="opacity:0;transition:opacity .25s">saved</span>
      </div>
      <textarea data-ta class="search" placeholder="Write something…"
        style="flex:1;resize:none;margin:3px 0 0;padding:7px 9px;font-size:12px;line-height:1.5;user-select:text"></textarea>`;

    const ta = body.querySelector<HTMLTextAreaElement>("[data-ta]")!;
    const hint = body.querySelector<HTMLElement>("[data-hint]")!;
    ta.value = initial;

    let debounce: number | undefined;
    let hintTimer: number | undefined;
    let dirty = false;

    const flashSaved = () => {
      hint.style.opacity = "1";
      if (hintTimer) window.clearTimeout(hintTimer);
      hintTimer = window.setTimeout(() => {
        hint.style.opacity = "0";
      }, 1000);
    };

    const onInput = () => {
      dirty = true;
      if (debounce) window.clearTimeout(debounce);
      debounce = window.setTimeout(() => {
        ctx.setSettings({ text: ta.value });
        dirty = false;
        flashSaved();
      }, 400);
    };
    ta.addEventListener("input", onInput);

    return {
      destroy() {
        ta.removeEventListener("input", onInput);
        if (debounce) window.clearTimeout(debounce);
        if (hintTimer) window.clearTimeout(hintTimer);
        if (dirty) ctx.setSettings({ text: ta.value });
      },
    };
  },
};

export default mod;
