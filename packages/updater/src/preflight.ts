import { isDevVersion } from '@haive/shared';
import { canUpgradeFrom, type ReleaseManifest } from '@haive/shared/release';

/**
 * Everything that must be true before an upgrade touches anything.
 *
 * Pure: the caller gathers the facts, this decides. Every refusal here costs nothing, which is the
 * entire reason preflight exists as a separate phase — the alternative is discovering the same
 * problem after the stack has been drained and the database migrated.
 */

export interface PreflightInput {
  /** What this install currently reports, from `GET /version`. */
  currentVersion: string;
  /** The manifest for the release being installed. */
  target: ReleaseManifest;
  /** Image references present on the local daemon right now. */
  localImages: readonly string[];
  /** Image references the CURRENT install runs — what a rollback would need. */
  currentImages: readonly string[];
  /** Free bytes where the snapshot would be written. */
  freeBytes: number;
  /** Bytes the snapshot is expected to need. */
  snapshotBytes: number;
}

export type PreflightRefusal =
  | 'dev-build'
  | 'same-version'
  | 'downgrade'
  | 'illegal-jump'
  | 'rollback-images-missing'
  | 'insufficient-disk';

export interface PreflightResult {
  ok: boolean;
  refusal?: PreflightRefusal;
  message?: string;
}

function versionParts(v: string): number[] | null {
  const core = v.split('-')[0] ?? '';
  const nums = core.split('.').map((p) => Number(p));
  return nums.length > 0 && nums.every((n) => Number.isInteger(n) && n >= 0) ? nums : null;
}

/** -1, 0 or 1, or null when either side cannot be read as a version. */
export function compareVersions(a: string, b: string): number | null {
  const x = versionParts(a);
  const y = versionParts(b);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? 0;
    const q = y[i] ?? 0;
    if (p !== q) return p > q ? 1 : -1;
  }
  return 0;
}

export function preflight(input: PreflightInput): PreflightResult {
  // A source checkout is not a thing that can be upgraded. An upgrade swaps published images for
  // other published images; a dev build runs none. Reported before the version arithmetic, because
  // `0.0.0-dev` would otherwise fall out of the ordering as an "illegal jump" — true, but a
  // confusing way to tell someone they are in the wrong tool.
  if (isDevVersion(input.currentVersion)) {
    return {
      ok: false,
      refusal: 'dev-build',
      message:
        `this install runs a development build (${input.currentVersion}), which has no published ` +
        `images to replace. Upgrades apply to installs created from a release.`,
    };
  }

  const cmp = compareVersions(input.currentVersion, input.target.version);

  // Re-running must be safe. An error here punishes exactly the reflex that follows a window
  // somebody is not sure finished.
  if (cmp === 0) {
    return {
      ok: false,
      refusal: 'same-version',
      message: `already running ${input.target.version}; nothing to do`,
    };
  }

  // A release that CONTRACTED the schema cannot be un-run, and older code against a newer schema is
  // undefined rather than merely slow. The way back is the snapshot the upgrade that moved you took.
  if (cmp === 1) {
    return {
      ok: false,
      refusal: 'downgrade',
      message:
        `refusing to move from ${input.currentVersion} back to ${input.target.version}. ` +
        `Restore the snapshot taken by the upgrade that moved this install forward.`,
    };
  }

  // The required-stop check. Refusing is not enough on its own — the caller resolves and NAMES the
  // intervening release, because an operator left to reconstruct the path from release notes is the
  // one outcome worse than either answer.
  if (!canUpgradeFrom(input.currentVersion, input.target)) {
    return {
      ok: false,
      refusal: 'illegal-jump',
      message:
        `${input.target.version} cannot be reached directly from ${input.currentVersion}: it ` +
        `requires at least ${input.target.minFrom}. Upgrade to ${input.target.minFrom} first.`,
    };
  }

  // An upgrade that cannot roll back is not an upgrade. `docker image prune` is a documented hazard
  // in this project, and it is silent — the images vanish and nothing notices until the moment the
  // health gate fails and there is nothing to go back to.
  const local = new Set(input.localImages);
  const missing = input.currentImages.filter((i) => !local.has(i));
  if (missing.length > 0) {
    return {
      ok: false,
      refusal: 'rollback-images-missing',
      message:
        `the images this install currently runs are no longer on the daemon, so a rollback would ` +
        `have nothing to return to: ${missing.join(', ')}. Re-pull them, or accept that this ` +
        `upgrade is one-way and re-run with --no-rollback.`,
    };
  }

  if (input.freeBytes < input.snapshotBytes) {
    return {
      ok: false,
      refusal: 'insufficient-disk',
      message:
        `the snapshot needs about ${Math.ceil(input.snapshotBytes / 1e9)} GB and only ` +
        `${Math.floor(input.freeBytes / 1e9)} GB is free`,
    };
  }

  return { ok: true };
}
