import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { RELEASE_BUNDLE_FILES, type ReleaseManifest } from '@haive/shared/release';
import type { ComposeContext } from './docker.js';
import { UpgradeRefusal } from './refusal.js';

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
  const differs = (files: Partial<Record<Name, string>>, names: readonly string[]) =>
    names.find((name) => !files[name as Name] || files[name as Name] !== installed.get(name));
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
    const differingFile = differs(
      files,
      RELEASE_BUNDLE_FILES.filter(
        (name) => compose.files.includes(name) || Object.hasOwn(files, name),
      ),
    );
    return differingFile ? { kind: 'modified', differingFile } : { kind: 'pristine' };
  }
  for (const files of bundle.known)
    if (!differs(files, compose.files)) return { kind: 'legacy-known' };
  return {
    kind: 'legacy-unknown',
    differingFile: differs(bundle.known[0] ?? bundle.files, compose.files) ?? compose.files[0],
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
  const owner = await stat(compose.dir);
  const installDir = resolve(compose.dir);
  let dir = installDir;
  for (const part of ['.haive-upgrade', 'pending', 'new']) {
    dir = join(dir, part);
    try {
      await mkdir(dir, { mode: owner.mode & 0o777 });
      const handle = await open(dir, 'r');
      try {
        await handle.chown(owner.uid, owner.gid);
        await handle.chmod(owner.mode & 0o777);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  for (const name of RELEASE_BUNDLE_FILES) {
    if (!bundle.files[name]) continue;
    const temp = join(dir, `.${name}.${randomUUID()}`);
    const file = await open(temp, 'wx', 0o644);
    try {
      await file.chown(owner.uid, owner.gid);
      await file.chmod(0o644);
      await file.writeFile(payload.get(name)!);
      await file.sync();
      await file.close();
      await rename(temp, join(dir, name));
    } finally {
      await file.close().catch(() => {});
      await unlink(temp).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
  const files = compose.files
    .filter((name) => bundle.files[name as Name])
    .map((name) => join(dir, name));
  return { dir: installDir, files };
}
