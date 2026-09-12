/** The task the page is currently showing, taken from the router path.
 *
 *  Pure and separate from the sidebar for the same reason `isNavItemActive` is: the sidebar
 *  is a client component and this rule needs a test more than it needs a render.
 *
 *  Returns null for the task LIST (`/tasks`) — nothing is open there, so nothing should be
 *  marked — and tolerates a null pathname, which is what `usePathname` yields before the
 *  router has resolved. A deeper path (`/tasks/<id>/terminal`) still resolves to the id,
 *  since the sidebar entry for that task is just as current. */
export function activeTaskIdFromPath(pathname: string | null | undefined): string | null {
  if (!pathname) return null;
  const match = /^\/tasks\/([^/?#]+)/.exec(pathname);
  return match?.[1] ?? null;
}
