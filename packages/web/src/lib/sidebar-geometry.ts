/** Geometry for the left sidebar: the expanded column's width and the collapsed rail.
 *
 *  Pure arithmetic only, same split of duties as `split-pane.ts`: the component owns the
 *  pointer plumbing, this module owns the numbers so the clamping is unit-testable.
 *
 *  Unlike `split-pane.ts` the value is in PIXELS, not a fraction of the viewport. The
 *  sidebar holds an icon grid and ellipsed task titles, both of which need a real minimum
 *  to stay legible — on a 3840px display a fraction that reads well on a laptop is a
 *  quarter of the screen.
 */

/** Below this the icon grid drops to two columns and a task title is all ellipsis. */
export const SIDEBAR_MIN_PX = 200;
/** The sidebar is an index, not a pane; past this it competes with the page. */
export const SIDEBAR_MAX_PX = 480;
/** What `w-64` was before this became resizable, so an existing user sees no change. */
export const SIDEBAR_DEFAULT_PX = 256;
/** Collapsed rail: one 48px icon column plus the aside's own padding. */
export const SIDEBAR_RAIL_PX = 56;

export function clampSidebarWidth(px: number): number {
  if (!Number.isFinite(px)) return SIDEBAR_DEFAULT_PX;
  return Math.round(Math.min(Math.max(px, SIDEBAR_MIN_PX), SIDEBAR_MAX_PX));
}

/** Divider drag -> new sidebar width. The sidebar is docked to the left edge, so the
 *  pointer's x IS the width; `left` is the aside's own offset, which is 0 in the app shell
 *  but is passed rather than assumed. */
export function widthFromPointer(clientX: number, left = 0): number {
  return clampSidebarWidth(clientX - left);
}

/** Width of the drag divider (`w-1`), which sits BESIDE the aside and so is part of the
 *  offset anything docked to the left edge has to clear. Not rendered when collapsed. */
export const SIDEBAR_DIVIDER_PX = 4;

/** CSS custom property carrying the live left-edge offset.
 *
 *  Elements that take themselves out of the flex row with `position: fixed` cannot see the
 *  sidebar's width any other way. Two do — the stale-build bar and the task page's title
 *  strip — and both used to hardcode `left-64`, which was correct only while the column was
 *  a fixed `w-64`. A variable rather than a prop because neither is a descendant of the
 *  sidebar, and passing a number through the layout into a page would couple them to it. */
export const SIDEBAR_WIDTH_VAR = '--haive-sidebar-w';

/** How far from the viewport's left edge the page content begins: the column plus its
 *  divider, or just the rail when collapsed (the divider is not rendered then). */
export function sidebarOffsetPx(collapsed: boolean, widthPx: number): number {
  return collapsed ? SIDEBAR_RAIL_PX : clampSidebarWidth(widthPx) + SIDEBAR_DIVIDER_PX;
}
