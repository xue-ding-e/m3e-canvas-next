import { Frame, Group, KIND_SPEC, NAV_BAR_H, PHONE_W, frameRect, frameSizeOf, hasPickerFields, isSheetBox, migrateCarousel, migrateFabMenu, migratePicker, migrateSheetBox } from "./tokens";

/** Documents saved before the bars grew their system insets have the navigation
 *  bar flush with the old 80dp bottom; keep it on the bottom edge. */
export function migrateGroups(groups: Group[], frames: Frame[]): Group[] {
  const oldNavH = KIND_SPEC.bottomNav.h - NAV_BAR_H;
  /* a badge was a part of its own once; it is gone, and a sketch that held one loses it */
  const kept = groups
    .map((g) => ({ ...g, items: g.items.filter((it) => (it.kind as string) !== "badge") }))
    .filter((g) => g.items.length > 0);
  /* a menu used to be a part of its own; now it is something a FAB is asked to open */
  let out = kept.map((g) => (g.items.some((it) => it.kind === "fabMenu") ? { ...g, items: g.items.map(migrateFabMenu) } : g));
  /* a carousel used to be one box with one caption and one destination; now every card has its own */
  out = out.map((g) => (g.items.some((it) => it.kind === "carousel" && (it.label || it.action)) ? { ...g, items: g.items.map(migrateCarousel) } : g));
  /* a picker used to carry a chosen day and time; it shows today and now, so those fields go */
  out = out.map((g) => (g.items.some(hasPickerFields) ? { ...g, items: g.items.map(migratePicker) } : g));
  /* a box with its handle on used to stand in for a bottom sheet; the sheet is its own part now */
  out = out.map((g) => (g.items.some(isSheetBox) ? { ...g, items: g.items.map(migrateSheetBox) } : g));
  /* a carousel is as wide as the screen it stands on, whatever size that screen is */
  out = out.map((g) => {
    if (!g.items.some((it) => it.kind === "carousel")) return g;
    const f = frames.find((fr) => {
      const r = frameRect(fr);
      return g.x >= r.l - 1 && g.x <= r.r && g.y >= r.t - 1 && g.y <= r.b;
    });
    const w = f ? frameSizeOf(f).w : PHONE_W;
    if (g.items.every((it) => it.kind !== "carousel" || (it.size ?? KIND_SPEC.carousel.defSize) === w)) return g;
    return { ...g, items: g.items.map((it) => (it.kind === "carousel" ? { ...it, size: w } : it)) };
  });
  return out.map((g) => {
    if (g.items.length !== 1 || g.items[0].kind !== "bottomNav") return g;
    const f = frames.find((fr) => {
      const r = frameRect(fr);
      return g.x >= r.l - 1 && g.x <= r.r && g.y === r.b - oldNavH;
    });
    return f ? { ...g, y: frameRect(f).b - KIND_SPEC.bottomNav.h } : g;
  });
}
