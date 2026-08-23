/** When the "this page is running older code" banner is allowed to show.
 *
 *  Its own tested module for the same reason lib/step-banners is one: the rule is small, and
 *  the ways to get it subtly wrong (firing on the first poll, firing forever after a dismiss,
 *  firing on a failed request) are each a banner that trains the user to ignore banners.
 *
 *  `baseline` is the stamp the FIRST poll returned, i.e. the code this page was loaded against —
 *  captured from the server rather than assumed, so a page that loads mid-edit is not instantly
 *  told the code moved under it. `current` is the newest stamp seen.
 *
 *  `dismissed` is the stamp the user dismissed, so a dismiss answers THAT change and the next
 *  one still speaks. */
export function shouldWarnStaleBuild(opts: {
  baseline: string | null;
  current: string | null;
  dismissed: string | null;
}): boolean {
  const { baseline, current, dismissed } = opts;
  // Nothing polled yet, or every poll failed. Silence is the only honest answer: a banner here
  // would be claiming a change we have no evidence of.
  if (baseline === null || current === null) return false;
  if (current === baseline) return false;
  return dismissed !== current;
}
