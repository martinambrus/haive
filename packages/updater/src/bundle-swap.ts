import { RELEASE_BUNDLE_FILES, type ReleaseManifest } from '@haive/shared/release';
import { bundleHash } from './bundle.js';
import type { ComposeContext } from './docker.js';
import { inDirectories, inInstall } from './install-files.js';

const RECORD = '.haive-bundle.json';
const NAMES = [...RELEASE_BUNDLE_FILES, RECORD] as const;
export type BundleState = {
  from: Record<string, string | null>;
  to: Record<string, string | null>;
  backupDir: string;
  overlay: 'docker-compose.gpu.yml' | 'docker-compose.vulkan.yml' | null;
};

/** A malformed present journal entry is an error, never permission to skip restoration. */
export function readBundleState(value: unknown): BundleState | undefined {
  if (value === undefined) return undefined;
  const invalid = (): never => {
    throw new Error('invalid journal bundle metadata');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const state = value as BundleState;
  if (
    typeof state.backupDir !== 'string' ||
    !/^\.haive-upgrade\/[A-Za-z0-9_-]+\/previous$/.test(state.backupDir) ||
    ![null, 'docker-compose.gpu.yml', 'docker-compose.vulkan.yml'].includes(state.overlay)
  )
    return invalid();
  for (const files of [state.from, state.to]) {
    if (
      !files ||
      typeof files !== 'object' ||
      Array.isArray(files) ||
      Object.keys(files).length !== NAMES.length
    )
      return invalid();
    for (const name of NAMES) {
      const hash = files[name];
      if (hash !== null && (typeof hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(hash)))
        return invalid();
    }
  }
  return state;
}

const selectedFiles = (files: BundleState['from']): string[] => [
  'docker-compose.yml',
  'docker-compose.run.yml',
  ...(files['docker-compose.gpu.yml']
    ? ['docker-compose.gpu.yml']
    : files['docker-compose.vulkan.yml']
      ? ['docker-compose.vulkan.yml']
      : []),
];

/** Copy all installed allowlisted files, including local edits and an absent record marker.
 * Caller journals this result before any swap or maintenance hold can start. */
export async function backupBundle(
  compose: ComposeContext,
  runId: string,
  target: ReleaseManifest,
): Promise<BundleState> {
  const backupDir = `.haive-upgrade/${runId}/previous`;
  // Validate before using the run id as a directory component.
  if (!/^\.haive-upgrade\/[A-Za-z0-9_-]+\/previous$/.test(backupDir))
    throw new Error('invalid bundle run id');
  return inInstall(compose.dir, async (root) => {
    const from: BundleState['from'] = {};
    const to: BundleState['to'] = {};
    await inDirectories(root, backupDir.split('/'), true, async (backup) => {
      for (const name of NAMES) {
        const current = await root.read(name);
        from[name] = current ? bundleHash(current.bytes) : null;
        to[name] = null;
        if (current) await backup.atomic(name, current.bytes, current.owner);
      }
    });
    for (const name of RELEASE_BUNDLE_FILES) {
      // Never add a GPU overlay to an install that did not have it.
      if (name === 'docker-compose.yml' || name === 'docker-compose.run.yml' || from[name])
        to[name] = target.bundle!.files[name] ?? from[name] ?? null;
    }
    const files = Object.fromEntries(
      RELEASE_BUNDLE_FILES.filter((name) => to[name]).map((name) => [name, to[name]]),
    );
    to[RECORD] = bundleHash(Buffer.from(JSON.stringify({ version: target.version, files }) + '\n'));
    const overlay = selectedFiles(from)[2] as BundleState['overlay'] | undefined;
    return { from, to, backupDir, overlay: overlay ?? null };
  });
}

/** Hash checks make both swap and restore repeatable after any individual rename. */
export async function swapBundle(
  compose: ComposeContext,
  state: BundleState,
  version: string,
): Promise<void> {
  await inInstall(compose.dir, async (root) => {
    const payload = new Map<string, Buffer>();
    await inDirectories(root, ['.haive-upgrade', 'pending', 'new'], false, async (staged) => {
      await inDirectories(root, state.backupDir.split('/'), false, async (backup) => {
        for (const name of RELEASE_BUNDLE_FILES) {
          if (!state.to[name]) continue;
          // An omitted installed overlay stays usable by the generated helper. Its verified
          // source is the backup, while every changed file must come from the staged release.
          const file =
            state.to[name] === state.from[name] ? await backup.read(name) : await staged.read(name);
          if (!file || bundleHash(file.bytes) !== state.to[name])
            throw new Error(`staged bundle hash mismatch: ${name}`);
          payload.set(name, file.bytes);
        }
      });
    });
    const files = Object.fromEntries(
      RELEASE_BUNDLE_FILES.filter((name) => state.to[name]).map((name) => [name, state.to[name]]),
    );
    payload.set(RECORD, Buffer.from(JSON.stringify({ version, files }) + '\n'));
    if (bundleHash(payload.get(RECORD)!) !== state.to[RECORD])
      throw new Error('bundle record hash mismatch');
    for (const name of NAMES) {
      const current = await root.read(name);
      if ((current ? bundleHash(current.bytes) : null) === state.to[name]) continue;
      if (!state.to[name]) await root.remove(name);
      else
        await root.atomic(
          name,
          payload.get(name)!,
          name === RECORD ? { ...(current?.owner ?? root.owner), mode: 0o644 } : undefined,
        );
    }
  });
  compose.files = selectedFiles(state.to);
}

export async function restoreBundle(compose: ComposeContext, state: BundleState): Promise<void> {
  await inInstall(compose.dir, async (root) => {
    await inDirectories(root, state.backupDir.split('/'), false, async (backup) => {
      // Validate the WHOLE backup first: a corrupt later file must not cause a partial restore.
      const saved = new Map<string, NonNullable<Awaited<ReturnType<typeof backup.read>>>>();
      for (const name of NAMES) {
        if (!state.from[name]) continue;
        const file = await backup.read(name);
        if (!file || bundleHash(file.bytes) !== state.from[name])
          throw new Error(`backup bundle hash mismatch: ${name}`);
        saved.set(name, file);
      }
      for (const name of NAMES) {
        const current = await root.read(name);
        if ((current ? bundleHash(current.bytes) : null) === state.from[name]) continue;
        const file = saved.get(name);
        if (file) await root.atomic(name, file.bytes, file.owner);
        else await root.remove(name);
      }
    });
  });
  compose.files = selectedFiles(state.from);
}

/** Only called after done: keep this run's previous/, discard older backups and staged payloads. */
export async function pruneBundles(compose: ComposeContext, state: BundleState): Promise<void> {
  const runId = state.backupDir.split('/')[1]!;
  await inInstall(compose.dir, (root) =>
    inDirectories(root, ['.haive-upgrade'], false, async (upgrades) => {
      for (const name of await upgrades.names()) {
        if (name !== runId) await upgrades.removeTree(name);
      }
      await inDirectories(upgrades, [runId], false, async (run) => {
        for (const name of await run.names()) if (name !== 'previous') await run.removeTree(name);
      });
    }),
  );
}
