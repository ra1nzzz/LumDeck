import type { GroupId, WidgetModule } from "./types";
import { GROUPS } from "./groups";

class WidgetRegistry {
  private modules = new Map<string, WidgetModule>();

  register(mod: WidgetModule): void {
    if (this.modules.has(mod.id)) {
      console.warn(`[registry] duplicate widget id "${mod.id}" ignored`);
      return;
    }
    this.modules.set(mod.id, mod);
  }

  registerAll(mods: WidgetModule[]): void {
    for (const m of mods) this.register(m);
  }

  get(id: string): WidgetModule | undefined {
    return this.modules.get(id);
  }

  all(): WidgetModule[] {
    return [...this.modules.values()];
  }

  byGroup(group: GroupId): WidgetModule[] {
    return this.all().filter((m) => m.group === group);
  }

  /** Counts per group, in group order, for the picker badges. */
  countsByGroup(): { id: GroupId; name: string; count: number }[] {
    return GROUPS.map((g) => ({ id: g.id, name: g.name, count: this.byGroup(g.id).length }));
  }
}

export const registry = new WidgetRegistry();
