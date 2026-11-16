import type { GroupId } from "./types";

export interface GroupDef {
  id: GroupId;
  name: string;
  icon: string;
}

// The 12 widget groups, in picker order.
export const GROUPS: GroupDef[] = [
  { id: "clocks", name: "Clocks", icon: clockIcon() },
  { id: "productivity", name: "Productivity", icon: checkIcon() },
  { id: "system", name: "System", icon: cpuIcon() },
  { id: "apps", name: "Apps & Files", icon: gridIcon() },
  { id: "media", name: "Media & Audio", icon: musicIcon() },
  { id: "ai", name: "AI", icon: sparkIcon() },
  { id: "analytics", name: "Analytics", icon: chartIcon() },
  { id: "social", name: "Social", icon: usersIcon() },
  { id: "stocks", name: "Stocks", icon: trendIcon() },
  { id: "finance", name: "Finance", icon: cashIcon() },
  { id: "weather", name: "Weather", icon: cloudIcon() },
  { id: "online", name: "Online & Mail", icon: mailIcon() },
];

function svg(inner: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}
function clockIcon() { return svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'); }
function checkIcon() { return svg('<path d="M9 11l3 3 8-8"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'); }
function cpuIcon() { return svg('<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>'); }
function gridIcon() { return svg('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'); }
function musicIcon() { return svg('<path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/>'); }
function sparkIcon() { return svg('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z"/>'); }
function chartIcon() { return svg('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'); }
function usersIcon() { return svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13A4 4 0 0 1 16 11"/>'); }
function trendIcon() { return svg('<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>'); }
function cashIcon() { return svg('<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>'); }
function cloudIcon() { return svg('<path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.1 9.5 4.5 4.5 0 0 0 7 19z"/>'); }
function mailIcon() { return svg('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 7l10 6 10-6"/>'); }
