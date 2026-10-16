import { spawn } from 'node:child_process';
import type { Database } from '@haive/database';
import { imageRepo, logger } from '@haive/shared';
import { removeOrphanedPreviousImage } from '../queues/cli-exec/images.js';
import { defaultDockerRunner, type DockerRunner } from './docker-runner.js';
import { CORE_IDENTITY_LABEL } from './sandbox-core-image.js';

const log = logger.child({ module: 'sandbox-image-reaper' });

const SANDBOX_REPO = imageRepo('cli-sandbox');
const PROVIDER_TAG_SUFFIX = /-[0-9a-f]{16}$/;

export interface SandboxImageReaperDeps {
  listImageRefs: () => Promise<string[]>;
  runner: DockerRunner;
}

/** Pure: the per-provider images among `refs`, which `resolveImageTag` tags `<repo>:<name>-<hash>`. The
 *  base image (`:latest`), composed images (their own repo) and anything else are never selected. */
export function selectProviderImageRefs(refs: string[]): string[] {
  const prefix = `${SANDBOX_REPO}:`;
  return refs.filter((ref) => ref.startsWith(prefix) && PROVIDER_TAG_SUFFIX.test(ref));
}

function docker(
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn('docker', args);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString('utf8')));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: stderr || err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

const defaultDeps: SandboxImageReaperDeps = {
  async listImageRefs() {
    const listed = await docker(
      ['images', '--filter', `reference=${SANDBOX_REPO}:*`, '--format', '{{.Repository}}:{{.Tag}}'],
      15_000,
    );
    if (!listed.ok) throw new Error(listed.stderr || 'docker images failed');
    return listed.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  },
  // Without --force, so docker refuses an image any container still uses.
  runner: {
    ...defaultDockerRunner,
    async remove(ref) {
      const result = await docker(['image', 'rm', ref], 30_000);
      return { ok: result.ok, stderr: result.stderr };
    },
  },
};

/** Remove the per-provider sandbox images no provider names, on worker boot. A removal only happens
 *  when a row moves off a tag, so an image whose removal failed, or one a release before that left,
 *  stayed for good. Each goes through the tag's turn and the check any removal makes, so a build
 *  claiming the tag is never undercut. Best-effort: never throws, returns the count removed. */
export async function reapOrphanedSandboxImages(
  db: Database,
  deps: SandboxImageReaperDeps = defaultDeps,
): Promise<number> {
  let removed = 0;
  try {
    for (const ref of selectProviderImageRefs(await deps.listImageRefs())) {
      try {
        const result = await removeOrphanedPreviousImage(
          db,
          { providerId: 'image-sweep', previousDbTag: ref, newTag: null },
          deps.runner,
        );
        if (result.removed) removed += 1;
      } catch (err) {
        log.warn({ err, ref }, 'orphaned sandbox image removal failed');
      }
    }
    if (removed > 0) log.info({ removed }, 'orphaned sandbox images removed');
  } catch (err) {
    log.warn({ err }, 'orphaned sandbox image sweep failed');
  }
  return removed;
}

export interface SupersededCoreReaperDeps {
  listSupersededCoreIds: () => Promise<string[]>;
  remove: (id: string) => Promise<{ ok: boolean; stderr: string }>;
}

const defaultCoreDeps: SupersededCoreReaperDeps = {
  async listSupersededCoreIds() {
    const listed = await docker(
      [
        'images',
        '--filter',
        'dangling=true',
        '--filter',
        `label=${CORE_IDENTITY_LABEL}`,
        '--format',
        '{{.ID}}',
      ],
      15_000,
    );
    if (!listed.ok) throw new Error(listed.stderr || 'docker images failed');
    return listed.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  },
  async remove(id) {
    const result = await docker(['image', 'rm', id], 30_000);
    return { ok: result.ok, stderr: result.stderr };
  },
};

/** Remove the base images a rebuild superseded, on worker boot: untagged, and stamped by a build of
 *  the base (a per-CLI image built on one inherits the stamp). Without --force, so docker refuses
 *  one that a container or an image built on it still uses, and a later boot takes it once neither
 *  does. The current base is tagged `:latest`, never dangling. Best-effort: never throws, returns
 *  the count removed. */
export async function reapSupersededSandboxCores(
  deps: SupersededCoreReaperDeps = defaultCoreDeps,
): Promise<number> {
  let removed = 0;
  try {
    for (const id of await deps.listSupersededCoreIds()) {
      const result = await deps.remove(id);
      if (result.ok) removed += 1;
      else log.debug({ id, stderr: result.stderr.trim() }, 'superseded sandbox base image kept');
    }
    if (removed > 0) log.info({ removed }, 'superseded sandbox base images removed');
  } catch (err) {
    log.warn({ err }, 'superseded sandbox base image sweep failed');
  }
  return removed;
}
