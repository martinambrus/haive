/** Comparing a provider's chosen reasoning level against its scale's default.
 *
 *  `EffortScaleMetadata.max` names the level a provider runs at when nothing is
 *  stored — for most CLIs that is also the highest level in `values`, but not for
 *  ollama, whose top level (`max`) is measured as unreliable and so is exposed
 *  without being the default. Equality against `.max` therefore answers "the user
 *  picked something other than the default", which flags a level ABOVE it as if it
 *  were below. Compare position in `values` (documented low-to-high) instead.
 */

/** Is `chosen` a weaker level than the scale's default?
 *
 *  False when the two are equal, when `chosen` sits above the default, and when
 *  either value is absent from `values` — an unorderable pair produces no warning
 *  rather than a wrong one (a stale DB row carrying a retired level must not
 *  masquerade as a downgrade).
 */
export function isBelowDefaultEffort(
  values: readonly string[],
  chosen: string,
  defaultLevel: string,
): boolean {
  const chosenIdx = values.indexOf(chosen);
  const defaultIdx = values.indexOf(defaultLevel);
  if (chosenIdx === -1 || defaultIdx === -1) return false;
  return chosenIdx < defaultIdx;
}
