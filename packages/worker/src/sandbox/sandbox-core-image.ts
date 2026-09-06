import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { logger } from '@haive/shared';
import { defaultDockerRunner, type DockerRunner } from './docker-runner.js';
import { SANDBOX_CORE_IMAGE } from './image-composer.js';

const log = logger.child({ module: 'sandbox-core-image' });

/** Matches the per-CLI and composed builds, which layer onto this same base. */
const BUILD_TIMEOUT_MS = 20 * 60 * 1000;

/** Stable headline for "the base every sandbox derives from is not on this host".
 *
 *  Written here and never matched anywhere — deliberately NOT in failure-class.ts with
 *  CLI_TIMEOUT_HEADLINE and friends, which exist so an inverse lookup can recover a class
 *  from a stored message and pick a retry strategy. Nothing branches on this one: it is a
 *  precondition failure with a single manual remedy, so it needs words, not a class. */
export const SANDBOX_CORE_IMAGE_HEADLINE = 'Sandbox base image could not be built';

/** Build context for SANDBOX_CORE_IMAGE, resolved the way ddev-runner resolves its own. */
function contextDir(): string {
  if (process.env.SANDBOX_CORE_CONTEXT) return process.env.SANDBOX_CORE_CONTEXT;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'sandbox-image');
}

/** Only forwarded when the operator actually pinned them, so an unset environment builds
 *  exactly what the Dockerfile's own ARG defaults produce — which is byte-for-byte what
 *  `pnpm docker sandbox-build` produces, since compose declares the same defaults. */
function resolveBuildArgs(): Record<string, string> {
  const args: Record<string, string> = {};
  const version = process.env.RTK_RELEASE_VERSION?.trim();
  const sha = process.env.RTK_X86_64_MUSL_SHA256?.trim();
  if (version) args.RTK_RELEASE_VERSION = version;
  if (sha) args.RTK_X86_64_MUSL_SHA256 = sha;
  return args;
}

/** In-flight build shared by every caller.
 *
 *  A promise rather than the boolean-set-on-success flag ddev-runner uses: cli-exec runs at
 *  concurrency 5-7 and several unrelated paths need this image, so a flag lets every one of
 *  them miss the check and shell out to the same multi-minute build. Same idiom as
 *  coalesceAuthPreparation in task-auth-volume.ts. */
let inFlight: Promise<void> | null = null;

async function ensureUnlocked(runner: DockerRunner): Promise<void> {
  if ((await runner.inspect(SANDBOX_CORE_IMAGE)).exists) return;

  const dir = contextDir();
  log.info({ image: SANDBOX_CORE_IMAGE, dir }, 'sandbox base image missing, building');
  const result = await runner.build({
    contextDir: dir,
    tag: SANDBOX_CORE_IMAGE,
    buildArgs: resolveBuildArgs(),
    timeoutMs: BUILD_TIMEOUT_MS,
  });

  if (result.exitCode !== 0) {
    const detail = (result.error ?? result.stderr ?? `exit ${result.exitCode}`).trim().slice(-4000);
    log.error(
      { image: SANDBOX_CORE_IMAGE, dir, exitCode: result.exitCode },
      'sandbox base image build failed',
    );
    throw new Error(
      `${SANDBOX_CORE_IMAGE_HEADLINE} — ${SANDBOX_CORE_IMAGE} is built locally from ${dir} ` +
        `and is published to no registry, so "docker image prune" or a fresh checkout removes ` +
        `it and Docker then tries to pull a repository that does not exist. Haive tried to ` +
        `rebuild it and the build itself failed. Run "pnpm docker sandbox-build" on the host, ` +
        `then retry this step. Build output:\n${detail}`,
    );
  }

  log.info(
    { image: SANDBOX_CORE_IMAGE, imageId: result.imageId, durationMs: result.durationMs },
    'sandbox base image built',
  );
}

/**
 * Guarantee `haive-cli-sandbox:latest` exists on this host, building it if it does not.
 *
 * Pass the image a caller is about to run so a host that pins its own base via
 * SANDBOX_IMAGE is left alone: building ours over an operator's tag would silently replace
 * their image. Callers that need the base by name (a `FROM` line, which ignores
 * SANDBOX_IMAGE) take the default.
 *
 * Present-image callers pay one `docker image inspect`; nothing is cached across calls
 * because the image can be pruned at any moment, which is the case this exists for.
 */
export function ensureSandboxCoreImage(
  image: string = SANDBOX_CORE_IMAGE,
  runner: DockerRunner = defaultDockerRunner,
): Promise<void> {
  if (image !== SANDBOX_CORE_IMAGE) return Promise.resolve();
  const existing = inFlight;
  if (existing) return existing;
  let tracked: Promise<void>;
  tracked = ensureUnlocked(runner).finally(() => {
    if (inFlight === tracked) inFlight = null;
  });
  inFlight = tracked;
  return tracked;
}
