import { createHash } from 'node:crypto';

/**
 * Categories of Haive-managed template output written by onboarding. Each
 * category has its own rendering rules and upgrade policy — e.g. marker-block
 * templates overlay into a user-owned file, plugin files are opaque blobs.
 */
export type TemplateKind =
  | 'agent'
  | 'agents-index'
  | 'command'
  | 'workflow-config'
  | 'plugin-file'
  | 'agents-md-block'
  | 'cli-rules-block'
  | 'mcp-settings'
  | 'custom-agent'
  | 'custom-skill'
  | 'rtk-config';

/**
 * Source of an `onboarding_artifacts` row. Distinguishes a fresh onboarding
 * write from an upgrade application, a rollback, and a lazy-backfill entry
 * reconstructed for a repo that onboarded before versioning shipped.
 */
export type ArtifactSource = 'onboarding' | 'upgrade' | 'rollback' | 'backfill';

/**
 * Concrete output of rendering a TemplateItem. A single template may expand
 * into multiple renderings — e.g. an agent template fans out to every enabled
 * CLI's native agents dir with per-CLI formatting.
 */
export interface TemplateRendering {
  diskPath: string;
  content: string;
}

/**
 * A versioned, renderable unit of deterministic template output. Registered
 * once per logical template regardless of how many files it emits. Content-hash
 * is derived by rendering against a reference context; any code change that
 * alters reference rendering bumps the hash automatically.
 */
export interface TemplateItem<TCtx = unknown> {
  id: string;
  kind: TemplateKind;
  /** Bump manually only on shape-breaking changes (new required input field,
   *  output file path rename). Content-only edits do not need a bump — the
   *  automatic contentHash detects them. */
  schemaVersion: number;
  /** Create-if-missing semantics; never overwritten on upgrade. Used for
   *  user-owned artefacts like mcp_settings.json. */
  isUserOwnedAfterWrite?: boolean;
  render(ctx: TCtx): TemplateRendering[];
}

/** TemplateItem augmented with the auto-computed content hash derived at
 *  manifest-build time. */
export interface ManifestItem<TCtx = unknown> extends TemplateItem<TCtx> {
  contentHash: string;
}

export interface TemplateManifest<TCtx = unknown> {
  items: ManifestItem<TCtx>[];
  setHash: string;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Canonicalize content for hashing/comparison. Normalizes CRLF to LF, strips
 *  trailing whitespace per line, collapses runs of 3+ blank lines to 2, and
 *  ensures exactly one trailing newline. Mirrors the semantics the existing
 *  file writers expect so disk/hash comparisons stay stable across platforms. */
export function normalizeContent(input: string): string {
  const unixified = input.replace(/\r\n/g, '\n');
  const trimmedLines = unixified
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n');
  const collapsed = trimmedLines.replace(/\n{3,}/g, '\n\n');
  const trimmed = collapsed.replace(/\n+$/, '');
  return `${trimmed}\n`;
}

export function hashRenderings(renderings: TemplateRendering[]): string {
  const parts = renderings
    .slice()
    .sort((a, b) => a.diskPath.localeCompare(b.diskPath))
    .map((r) => `${r.diskPath}\n${normalizeContent(r.content)}`);
  return sha256Hex(parts.join('\n---\n'));
}

export function computeSetHash(
  items: ReadonlyArray<{ id: string; schemaVersion: number; contentHash: string }>,
): string {
  const sorted = items
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((i) => `${i.id}:${i.schemaVersion}:${i.contentHash}`)
    .join('\n');
  return sha256Hex(sorted);
}

/** Build a manifest by computing each item's contentHash against the supplied
 *  reference context, then derive the aggregate set hash. The reference
 *  context is canonical and must be stable across worker restarts — it should
 *  contain no timestamps, no random values, and no per-user data. */
export function buildManifest<TCtx>(
  items: ReadonlyArray<TemplateItem<TCtx>>,
  referenceCtx: TCtx,
): TemplateManifest<TCtx> {
  const withHashes: ManifestItem<TCtx>[] = items.map((item) => ({
    ...item,
    contentHash: hashRenderings(item.render(referenceCtx)),
  }));
  return {
    items: withHashes,
    setHash: computeSetHash(withHashes),
  };
}

/** Shape of the `.haive/install.json` manifest written into a user's repo.
 *  Secondary source of truth — DB is authoritative; install.json is the
 *  portable/visible reflection committed alongside other onboarding output. */
export interface InstallManifest {
  schemaVersion: 1;
  haiveVersion: string;
  appliedAt: string;
  lastTaskId: string;
  templateSetHash: string;
  templates: Array<{
    id: string;
    schemaVersion: number;
    contentHash: string;
    diskPaths: string[];
  }>;
  /** Custom bundles installed for this repo. Optional — older install.json
   *  files written before bundle support shipped omit it; consumers must
   *  treat `undefined` as "no bundles installed" and not as a schema version
   *  bump. */
  bundles?: Array<{
    id: string;
    name: string;
    sourceType: 'zip' | 'git';
    lastSyncCommit: string | null;
    itemCount: number;
  }>;
}
