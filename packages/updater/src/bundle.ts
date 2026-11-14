import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { RELEASE_BUNDLE_FILES, type ReleaseManifest } from '@haive/shared/release';
import type { ComposeContext } from './docker.js';
import { UpgradeRefusal } from './refusal.js';
import { inDirectories, inInstall } from './install-files.js';

type Bundle = NonNullable<ReleaseManifest['bundle']>;
type Name = (typeof RELEASE_BUNDLE_FILES)[number];
export const bundleHash = (bytes: Buffer): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export interface BundleClassification {
  kind: 'pristine' | 'modified' | 'legacy-known' | 'legacy-unknown';
  differingFile?: string;
}

/** Historical manifests include both overlays, but an installer writes just its selected overlay.
 * Records describe the actual install: check all recorded files as well as the active file list. */
export async function classifyBundle(
  compose: ComposeContext,
  bundle: Bundle,
): Promise<BundleClassification> {
  const installed = new Map<string, string | undefined>();
  for (const name of RELEASE_BUNDLE_FILES) {
    const bytes = await readFile(join(compose.dir, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    installed.set(name, bytes === undefined ? undefined : bundleHash(bytes));
  }
  const record = await readFile(join(compose.dir, '.haive-bundle.json'), 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    },
  );
  const differingFiles = (files: Partial<Record<Name, string>>, names: readonly string[]) =>
    names.filter((name) => !files[name as Name] || files[name as Name] !== installed.get(name));
  if (record !== undefined) {
    let files: Bundle['files'];
    try {
      const parsed = JSON.parse(record);
      if (
        !parsed ||
        typeof parsed.version !== 'string' ||
        !parsed.files ||
        typeof parsed.files !== 'object' ||
        Array.isArray(parsed.files) ||
        Object.keys(parsed.files).some(
          (key) => !(RELEASE_BUNDLE_FILES as readonly string[]).includes(key),
        )
      )
        throw new Error('invalid record');
      files = parsed.files;
    } catch {
      return { kind: 'modified', differingFile: '.haive-bundle.json' };
    }
    const differingFile = differingFiles(
      files,
      RELEASE_BUNDLE_FILES.filter(
        (name) => compose.files.includes(name) || Object.hasOwn(files, name),
      ),
    )[0];
    return differingFile ? { kind: 'modified', differingFile } : { kind: 'pristine' };
  }
  let closest: string[] | undefined;
  for (const files of bundle.known) {
    const differences = differingFiles(files, compose.files);
    if (differences.length === 0) return { kind: 'legacy-known' };
    if (!closest || differences.length < closest.length) closest = differences;
  }
  return {
    kind: 'legacy-unknown',
    differingFile: (closest ?? differingFiles(bundle.files, compose.files))[0] ?? compose.files[0],
  };
}

export function requireUnmodifiedBundle(
  classification: BundleClassification,
  replace: boolean,
): void {
  if (!replace && (classification.kind === 'modified' || classification.kind === 'legacy-unknown'))
    throw new UpgradeRefusal(
      'bundle-modified',
      `installed bundle differs at ${classification.differingFile}; use --replace-modified-bundle to accept replacing local edits`,
    );
}

/** Stage only the schema's fixed allowlist; neither image tar names nor journal values supply paths. */
export async function stageBundle(
  compose: ComposeContext,
  bundle: Bundle,
  payload: Map<string, Buffer>,
): Promise<ComposeContext> {
  // Validate the entire payload before creating even the staging directories.
  for (const name of RELEASE_BUNDLE_FILES) {
    if (!bundle.files[name]) continue;
    const bytes = payload.get(name);
    if (!bytes || bundleHash(bytes) !== bundle.files[name])
      throw new UpgradeRefusal(
        'bundle-invalid',
        `release bundle hash mismatch or missing file: ${name}`,
      );
  }
  const installDir = resolve(compose.dir);
  const dir = join(installDir, '.haive-upgrade', 'pending', 'new');
  await inInstall(installDir, (root) =>
    inDirectories(root, ['.haive-upgrade', 'pending', 'new'], true, async (staged) => {
      for (const name of RELEASE_BUNDLE_FILES) {
        if (bundle.files[name])
          await staged.atomic(name, payload.get(name)!, { ...root.owner, mode: 0o644 });
      }
    }),
  );
  const files = compose.files.map((name) =>
    bundle.files[name as Name] ? join(dir, name) : join(installDir, name),
  );
  return { dir: installDir, files };
}
