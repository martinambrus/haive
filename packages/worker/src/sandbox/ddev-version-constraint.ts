/** Repair for an unsatisfiable `ddev_version_constraint` in a project's .ddev/config.yaml.
 *
 *  Nothing in Haive writes that key — the implementing agent does, unprompted, because pinning
 *  is ordinary DDEV practice. Agents disagree wildly on the spelling (ranges with and without
 *  the `v`, with and without a comma, all fine) and some write an EXACT version. An exact pin
 *  is dead on arrival the moment the runner's DDEV differs from whatever the agent happened to
 *  see, which is a matter of when the runner image was last built — so the task dies on a
 *  detail that has nothing to do with its actual work, and no amount of retrying can fix it.
 *
 *  Two unsatisfiable shapes reach production, both repaired here:
 *   - an EXACT pin (`v1.25.2`, `= v1.25.2`) — relaxExactDdevVersionConstraint, runner-independent;
 *   - a RANGE whose ceiling sits below the runner (`>= v1.24.10 < v1.25.0` on a v1.25.x runner)
 *     — relaxCappedDdevConstraintForRunner, keyed on the version DDEV reported.
 *
 *  Pure and DOM/db-free so it unit-tests directly. */

/** The `ddev_version_constraint:` line, captured as (indent+key)(value). Anchored per-line on
 *  the YAML key, which is the stable contract here — not on ddev's error wording. */
const CONSTRAINT_LINE_RE = /^([ \t]*ddev_version_constraint:[ \t]*)(\S.*?)[ \t]*$/m;

/** A single version pinned to itself, whether or not the equality is spelled out: `v1.25.2`,
 *  `1.25.2`, `= v1.25.2`, `==1.25.2`. All of these mean "this version and nothing else" and
 *  all fail identically against a runner on any other patch — an agent writing the `=` form
 *  is the case that reached production. A value carrying any OTHER operator (`>=`, `<=`, `>`,
 *  `<`, `~`, `^`, `!=`) is a range, handled by relaxCappedDdevConstraintForRunner when it is a
 *  too-low ceiling and left alone otherwise. */
const EXACT_PIN_RE = /^(?:={1,2}[ \t]*)?v?(\d+)\.(\d+)\.(\d+)$/;

/** A lower bound inside a range value: `>= v1.24.10` or `> v1.24.10`. Captures op + version. */
const FLOOR_RE = /(>=?)[ \t]*v?(\d+)\.(\d+)\.(\d+)/;

/** First `x.y.z` (optionally `v`-prefixed) in a string — used to read a version out of prose. */
const VERSION_RE = /v?(\d+)\.(\d+)\.(\d+)/;

export interface RelaxedConstraint {
  /** The rewritten file contents. */
  text: string;
  /** The original value that was found (unquoted). */
  from: string;
  /** The range it became (unquoted). */
  to: string;
}

type Triple = [number, number, number];

function parseTriple(s: string): Triple | null {
  const m = VERSION_RE.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmpTriple(a: Triple, b: Triple): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
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
 * Returns null when there is no constraint line, or when the value carries a comparator that
 * makes it a real range (relaxCappedDdevConstraintForRunner handles the fixable range shape).
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

/**
 * Repair a RANGE whose upper bound the runner cannot meet — `">= v1.24.10 < v1.25.0"` against a
 * runner on `v1.25.3`. The floor is satisfied; only the ceiling, pinned below the only DDEV the
 * runner has, makes the whole constraint unsatisfiable. Keep the agent's floor and push the
 * ceiling to the next MAJOR above the runner, so the constraint admits the runner while
 * preserving the "at least <floor>" intent (same major-boundary reasoning as the exact-pin path).
 *
 * Unlike the exact-pin relaxer this needs the runner version, because the decision is entirely
 * about where the runner sits relative to the bounds — so it is keyed on the version DDEV itself
 * reported in its rejection, never a hardcoded one, and stays correct across runner-image bumps.
 *
 * Returns null (caller keeps the actionable error) when:
 *  - there is no constraint line, the runner version is unparseable, or the value has no
 *    `>=`/`>` floor (an exact pin is the other function's job; a ceiling-only value carries no
 *    minimum-version intent worth preserving);
 *  - the runner is BELOW the floor — the agent wants a NEWER DDEV than exists here, a genuine
 *    "upgrade the runner" failure we must not paper over by lowering the floor;
 *  - the rewrite would not change the value (nothing to repair — keeps it idempotent).
 */
export function relaxCappedDdevConstraintForRunner(
  configText: string,
  runnerVersion: string,
): RelaxedConstraint | null {
  const match = CONSTRAINT_LINE_RE.exec(configText);
  if (!match) return null;
  const [line, keyPart, rawValue] = match as unknown as [string, string, string];
  const value = rawValue.replace(/^['"]|['"]$/g, '').trim();

  const runner = parseTriple(runnerVersion);
  if (!runner) return null;

  const floorMatch = FLOOR_RE.exec(value);
  if (!floorMatch) return null;
  const floor: Triple = [Number(floorMatch[2]), Number(floorMatch[3]), Number(floorMatch[4])];
  // Runner older than the floor: widening the ceiling cannot help, and lowering the floor would
  // discard the agent's minimum-version intent. Fail loud with the actionable error instead.
  if (cmpTriple(runner, floor) < 0) return null;

  const to = `>= v${floor[0]}.${floor[1]}.${floor[2]} < v${runner[0] + 1}.0.0`;
  if (to === value) return null;
  return {
    text: configText.replace(line, `${keyPart}"${to}"`),
    from: value,
    to,
  };
}
