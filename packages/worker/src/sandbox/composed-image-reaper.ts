import { spawn } from 'node:child_process';
import { logger } from '@haive/shared';
import { COMPOSED_IMAGE_REPO } from './image-composer.js';
import { defaultDockerRunner, type DockerRunner } from './docker-runner.js';

const log = logger.child({ module: 'composed-image-reaper' });

// Composed sandbox images (`haive-sandbox:<hash>`) are hash-cached for cross-task
// reuse and nothing ever removed them, so they accumulate one image per unique
// (env-template, provider, rtk) build forever. Evict tags older than this that no
// running container uses. Removal is safe: a live task that still needs an evicted
// tag simply rebuilds it on next use (a cache miss — self-healing, never broken).
// Override with HAIVE_COMPOSED_IMAGE_MAX_AGE_DAYS.
const DEFAULT_MAX_AGE_DAYS = 14;

export function composedImageMaxAgeMs(): number {
  const raw = Number(process.env.HAIVE_COMPOSED_IMAGE_MAX_AGE_DAYS);
  const days = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_AGE_DAYS;
  return days * 24 * 60 * 60 * 1000;
}

export interface ComposedImageInfo {
  /** `haive-sandbox:<hash>` tag used to remove the image. */
  ref: string;
  /** `sha256:...` image id, matched against running-container images. */
  id: string;
  createdAtMs: number;
}

/** Pure: the composed image refs to evict — older than maxAge AND not backing a
 *  running container (matched by tag or image id). Split out so the selection is
 *  unit-testable without docker. Images with an unparseable creation time
 *  (createdAtMs = NaN) are kept, never reaped. */
export function selectStaleComposedImages(
  images: ComposedImageInfo[],
  runningImageRefs: ReadonlySet<string>,
  nowMs: number,
  maxAgeMs: number,
): string[] {
  return images
    .filter((img) => !runningImageRefs.has(img.ref) && !runningImageRefs.has(img.id))
    .filter((img) => Number.isFinite(img.createdAtMs) && nowMs - img.createdAtMs >= maxAgeMs)
    .map((img) => img.ref);
}

/** Reap stale composed sandbox images. Runs at worker boot as a backstop
 *  (mirrors reapOrphanEnvTemplates): best-effort, never throws, returns the
 *  count removed. Boot-time is sufficient because cli-exec/terminal containers —
 *  the only users of composed images — are reaped just before this runs, and the
 *  age threshold keeps every recently-built image regardless. */
export async function reapStaleComposedImages(
  maxAgeMs: number = composedImageMaxAgeMs(),
  nowMs: number = Date.now(),
  runner: DockerRunner = defaultDockerRunner,
): Promise<number> {
  try {
    const refs = await listComposedImageRefs();
    if (refs.length === 0) return 0;
    const [images, running] = await Promise.all([
      inspectComposedImages(refs),
      listRunningImageRefs(),
    ]);
    const stale = selectStaleComposedImages(images, running, nowMs, maxAgeMs);
    if (stale.length === 0) return 0;

    let reaped = 0;
    for (const ref of stale) {
      // `docker image rm -f` still refuses an image backing a running container
      // (fails cleanly), so a container we didn't catch above is never nuked.
      const rm = await runner.remove(ref);
      if (rm.ok) reaped += 1;
      else log.warn({ ref, stderr: rm.stderr }, 'stale composed image removal failed (kept)');
    }
    if (reaped > 0) {
      log.info({ reaped, candidates: images.length }, 'stale composed sandbox images reaped');
    }
    return reaped;
  } catch (err) {
    log.warn({ err }, 'composed-image reap failed');
    return 0;
  }
}

/** Run `docker` and resolve its stdout lines (trimmed, non-empty). Never rejects:
 *  a spawn error or timeout resolves to [] so a docker hiccup can't break boot. */
function dockerLines(args: string[], timeoutMs = 15_000): Promise<string[]> {
  return new Promise((resolve) => {
    let stdout = '';
    const child = spawn('docker', args);
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.on('close', () => {
      resolve(
        stdout
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0),
      );
    });
    child.on('error', () => resolve([]));
    setTimeout(() => {
      child.kill('SIGKILL');
      resolve([]);
    }, timeoutMs);
  });
}

async function listComposedImageRefs(): Promise<string[]> {
  // `<none>:<none>` (dangling) tags are skipped — they carry no reusable ref.
  const lines = await dockerLines([
    'images',
    '--filter',
    `reference=${COMPOSED_IMAGE_REPO}:*`,
    '--format',
    '{{.Repository}}:{{.Tag}}',
  ]);
  return lines.filter((r) => r.startsWith(`${COMPOSED_IMAGE_REPO}:`) && !r.endsWith(':<none>'));
}

async function inspectComposedImages(refs: string[]): Promise<ComposedImageInfo[]> {
  // One batched inspect; RepoTags recovers each image's own haive-sandbox tag so
  // the id/created line correlates back to a removable ref.
  const lines = await dockerLines([
    'image',
    'inspect',
    '--format',
    '{{.Id}}|{{.Created}}|{{range .RepoTags}}{{.}} {{end}}',
    ...refs,
  ]);
  const out: ComposedImageInfo[] = [];
  for (const line of lines) {
    const [id, created, tagList] = line.split('|');
    if (!id || !created) continue;
    const ref = (tagList ?? '')
      .split(/\s+/)
      .find((t) => t.startsWith(`${COMPOSED_IMAGE_REPO}:`) && !t.endsWith(':<none>'));
    if (!ref) continue;
    out.push({ ref, id, createdAtMs: new Date(created).getTime() });
  }
  return out;
}

async function listRunningImageRefs(): Promise<Set<string>> {
  const lines = await dockerLines(['ps', '--no-trunc', '--format', '{{.Image}}']);
  return new Set(lines);
}
