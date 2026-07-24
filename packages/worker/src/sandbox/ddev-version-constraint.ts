/** Repair for an unsatisfiable `ddev_version_constraint` in a project's .ddev/config.yaml.
 *
 *  Nothing in Haive writes that key — the implementing agent does, unprompted, because pinning
 *  is ordinary DDEV practice. Agents disagree wildly on the spelling (ranges with and without
 *  the `v`, with and without a comma, all fine) and some write an EXACT version. An exact pin
 *  is dead on arrival the moment the runner's DDEV differs from whatever the agent happened to
 *  see, which is a matter of when the runner image was last built — so the task dies on a
 *  detail that has nothing to do with its actual work, and no amount of retrying can fix it.
 *
 *  Pure and DOM/db-free so it unit-tests directly. */

/** The `ddev_version_constraint:` line, captured as (indent+key)(value). Anchored per-line on
 *  the YAML key, which is the stable contract here — not on ddev's error wording. */
const CONSTRAINT_LINE_RE = /^([ \t]*ddev_version_constraint:[ \t]*)(\S.*?)[ \t]*$/m;

/** A bare version with no comparator: `v1.25.2`, `1.25.2`. This is the only shape we rewrite —
 *  a value carrying any operator is a range the agent thought about, and second-guessing it
 *  (widening someone's deliberate upper bound) is not our call. */
const EXACT_PIN_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

export interface RelaxedConstraint {
  /** The rewritten file contents. */
  text: string;
  /** The exact pin that was found (unquoted). */
  from: string;
  /** The range it became (unquoted). */
  to: string;
}

/**
 * Rewrite an exact `ddev_version_constraint` pin into a range that keeps the agent's floor and
 * bounds the MAJOR version: `'v1.24.8'` -> `">= v1.24.8 < v2.0.0"`.
 *
 * Bounding the major rather than the minor is deliberate. DDEV ships minors often — a
 * `< v1.26.0` bound just moves the same breakage a few weeks out — while a major is the real
 * compatibility boundary and the one the agent plausibly meant to guard. The floor is kept
 * verbatim so the agent's intent ("at least this version") survives.
 *
 * Returns null when there is no constraint line, or when the value already carries a
 * comparator; the caller then keeps today's actionable error.
 */
export function relaxExactDdevVersionConstraint(configText: string): RelaxedConstraint | null {
  const match = CONSTRAINT_LINE_RE.exec(configText);
  if (!match) return null;
  const [line, keyPart, rawValue] = match as unknown as [string, string, string];
  const value = rawValue.replace(/^['"]|['"]$/g, '').trim();
  const pin = EXACT_PIN_RE.exec(value);
  if (!pin) return null;
  const [, major, minor, patch] = pin as unknown as [string, string, string, string];
  const to = `>= v${major}.${minor}.${patch} < v${Number(major) + 1}.0.0`;
  return {
    text: configText.replace(line, `${keyPart}"${to}"`),
    from: value,
    to,
  };
}
