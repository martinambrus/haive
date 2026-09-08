import { z } from 'zod';

/**
 * The release manifest — what an install reads to decide whether, and to what, it may upgrade.
 *
 * Published per TAG and per CHANNEL. A module customer does not run the public images (see
 * `serialized-chasing-thacker`), so an install resolves the manifest for ITS channel and never the
 * public one by default; only the digests differ between channels, because `minFrom` and
 * `migrationHead` come from the base release either way.
 *
 * Validated with zod rather than trusted: this document is FETCHED, and an upgrade acts on it.
 */

/** Digests of the images a release publishes. Absent on a channel that builds locally — an install
 *  carrying the user's own modules builds api and worker from a `haive-builder` image, so its
 *  running images have local tags no manifest can name. */
export const releaseImagesSchema = z.object({
  api: z.string().min(1).optional(),
  worker: z.string().min(1).optional(),
  web: z.string().min(1).optional(),
});

export const releaseManifestSchema = z.object({
  /** Schema version of THIS document, so a future updater can refuse one it cannot read. */
  manifestVersion: z.literal(1),
  /** The release, from the git tag. Never the dev sentinel — a dev build publishes nothing. */
  version: z.string().min(1),
  /** Which channel this manifest describes. `public` unless it is a per-customer build. */
  channel: z.string().min(1).default('public'),
  /** ISO timestamp of the build. */
  builtAt: z.string().min(1),
  /**
   * The lowest version that may upgrade DIRECTLY to this one.
   *
   * Declared, never inferred. It is how a release says "you must pass through vX first" — because
   * a migration was destructive, or a data migration only runs on the way through. An upgrade that
   * skips a required stop is the failure this field exists to refuse, and it must be refused in
   * pre-flight where nothing has been touched yet.
   *
   * The default is PERMISSIVE, and that direction is deliberate. Refusing is usually the safe way
   * to fail, but not here: a floor equal to the release itself means only that release may upgrade
   * to itself, i.e. every real upgrade is refused. MEASURED — the generator originally defaulted
   * this to the release version and a 0.1.0 install could not reach 0.2.0. Safety against a
   * destructive release comes from `contracts` and the pre-flight snapshot, not from this field;
   * this field only enforces stops a release has actually declared.
   */
  minFrom: z.string().min(1).default('0.0.0'),
  /**
   * The highest migration id this release ships.
   *
   * Lets an upgrade tell "the new image booted" from "the new image booted AND its migrations
   * landed" — the distinction a health check alone cannot make.
   */
  migrationHead: z.string().min(1),
  /**
   * True when this release contains a migration that removes something.
   *
   * Additive-only releases can roll back by re-pinning the previous tag and leaving the schema
   * alone. A release that CONTRACTS the schema cannot, so this flag tells the upgrade that its
   * snapshot is load-bearing rather than insurance.
   */
  contracts: z.boolean().default(false),
  images: releaseImagesSchema.default({}),
});

export type ReleaseImages = z.infer<typeof releaseImagesSchema>;
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

/** Parse a fetched manifest, throwing on anything malformed. */
export function parseReleaseManifest(input: unknown): ReleaseManifest {
  return releaseManifestSchema.parse(input);
}

/**
 * Whether `from` may upgrade directly to the release this manifest describes.
 *
 * Compares dotted numeric parts left to right and ignores any pre-release suffix, which is enough
 * for the only question asked here — "is this at or above the declared floor". A version that
 * cannot be parsed is REFUSED rather than assumed newer: the caller is about to migrate a database
 * on the strength of this answer.
 */
export function canUpgradeFrom(from: string, manifest: ReleaseManifest): boolean {
  const parts = (v: string): number[] | null => {
    const core = v.split('-')[0] ?? '';
    const nums = core.split('.').map((p) => Number(p));
    return nums.length > 0 && nums.every((n) => Number.isInteger(n) && n >= 0) ? nums : null;
  };
  const a = parts(from);
  const b = parts(manifest.minFrom);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}
