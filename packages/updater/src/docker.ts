import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileNoFollow } from '@haive/shared/fs-safe';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTAINER_FAMILY, containerName } from '@haive/shared/naming';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';

const exec = promisify(execFile);

/**
 * Thin shell wrappers. Deliberately thin: everything that DECIDES lives in `phases.ts` and
 * `preflight.ts`, which are pure and tested, so this module has no branching worth testing and
 * nothing to get subtly wrong.
 *
 * `docker compose` rather than the API: the compose file IS the deployment description, and
 * re-implementing its dependency ordering and health gating against the daemon API would be
 * re-writing the thing the install already ships.
 */

export interface ComposeContext {
  /** The install directory holding docker-compose.yml, the run overlay and .env. */
  dir: string;
  /** Overlay files, in order. */
  files: string[];
}

/** Node puts the whole command line into a failed exec's message, and one-shot containers are
 *  handed DATABASE_URL and CONFIG_ENCRYPTION_KEY as `-e` arguments. MEASURED during the first real
 *  upgrade: a failing commit phase printed the Postgres password into the log — and therefore into
 *  the journal and anything shipping those logs. Redacted at the ONE place every command goes
 *  through, rather than at each call site, so a new caller cannot forget. */
const SECRET_ARG = /(-e [A-Z_]*(?:URL|KEY|SECRET|PASSWORD|TOKEN)=)\S+/g;

export function redactSecrets(text: string): string {
  return text.replace(SECRET_ARG, '$1<redacted>');
}

async function run(
  cmd: string,
  args: string[],
  cwd?: string,
  timeoutMs = 600_000,
): Promise<string> {
  try {
    const { stdout } = await exec(cmd, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    throw new Error(redactSecrets(err instanceof Error ? err.message : String(err)));
  }
}

function composeArgs(ctx: ComposeContext, rest: string[]): string[] {
  return [...ctx.files.flatMap((f) => ['-f', f]), ...rest];
}

/** Image references present on this daemon. Used by preflight to prove a rollback has somewhere to
 *  go back to before anything is touched. */
export async function localImages(includeDigests = false): Promise<string[]> {
  if (includeDigests) {
    const out = await run('docker', [
      'image',
      'ls',
      '--digests',
      '--format',
      '{{.Repository}}:{{.Tag}}\t{{.Repository}}@{{.Digest}}',
    ]);
    return [...new Set(out.split(/\s+/).filter((ref) => ref && !ref.includes('<none>')))];
  }
  const out = await run('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}']);
  return out.split('\n').filter(Boolean);
}

export async function pullImages(ctx: ComposeContext, env: NodeJS.ProcessEnv): Promise<void> {
  await exec('docker', ['compose', ...composeArgs(ctx, ['pull'])], {
    cwd: ctx.dir,
    env,
    timeout: 1_800_000,
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** Bring services up. `services` empty means the whole stack. */
export async function composeUp(
  ctx: ComposeContext,
  env: NodeJS.ProcessEnv,
  services: string[] = [],
): Promise<void> {
  await exec('docker', ['compose', ...composeArgs(ctx, ['up', '-d', ...services])], {
    cwd: ctx.dir,
    env,
    timeout: 1_800_000,
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** Stop services WITHOUT `-v`. Never `-v`: several volumes are globally named and shared with any
 *  other install on the machine, so `-v` would take that install's repositories with it. */
export async function composeStop(
  ctx: ComposeContext,
  env: NodeJS.ProcessEnv,
  services: string[],
): Promise<void> {
  await exec('docker', ['compose', ...composeArgs(ctx, ['stop', ...services])], {
    cwd: ctx.dir,
    env,
    timeout: 600_000,
  });
}

/** Snapshot filenames are ours, not a user's — but they are the only values that reach a shell in
 *  this module, so they are constrained rather than trusted. A guard costs nothing and states the
 *  invariant where the next person will read it. */
const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;

function assertSafeFilename(name: string): void {
  if (!SAFE_FILENAME.test(name)) {
    throw new Error(`refusing an unsafe snapshot filename: ${JSON.stringify(name)}`);
  }
}

/** Copy a named volume into a tarball, with the writer container mounting it read-only.
 *  Used for the pre-migration snapshot, with Postgres stopped.
 *
 *  No `sh -c`: tar is invoked directly, so nothing here reaches a shell at all. */
export async function snapshotVolume(
  volume: string,
  outDir: string,
  outFile: string,
): Promise<void> {
  assertSafeFilename(outFile);
  await run('docker', [
    'run',
    '--rm',
    '-v',
    `${volume}:/from:ro`,
    '-v',
    `${outDir}:/to`,
    'alpine:3',
    'tar',
    'czf',
    `/to/${outFile}`,
    '-C',
    '/from',
    '.',
  ]);
}

/** Restore a snapshot over a named volume. The inverse of the above, and the only supported way
 *  back from a release that contracted the schema. */
export async function restoreVolume(volume: string, inDir: string, inFile: string): Promise<void> {
  // This one genuinely needs a shell — the target has to be emptied before the tar is unpacked
  // over it — so the filename is validated first.
  assertSafeFilename(inFile);
  await run('docker', [
    'run',
    '--rm',
    '-v',
    `${volume}:/to`,
    '-v',
    `${inDir}:/from:ro`,
    'alpine:3',
    'sh',
    '-c',
    `cd /to && rm -rf ./* ./..?* 2>/dev/null; tar xzf /from/${inFile} -C /to`,
  ]);
}

/** Run a one-shot container from an image, returning its stdout. Used to drive the migration
 *  runner out of the TARGET image, so migrations are always the new version's. */
export async function runOneShot(
  image: string,
  args: string[],
  env: Record<string, string>,
  network?: string,
): Promise<string> {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return run('docker', [
    'run',
    '--rm',
    ...(network ? ['--network', network] : []),
    ...envArgs,
    image,
    ...args,
  ]);
}

/** The daemon resolves the prepared source mount, just like snapshotHostDir. No npm credential. */
export async function buildOwnModules(
  image: string,
  sourceHostDir: string,
  plan: Record<string, unknown>,
  dockerConfigHostDir?: string,
): Promise<void> {
  await run('docker', ['pull', image], undefined, 1_800_000);
  await run(
    'docker',
    [
      'run',
      '--rm',
      '--mount',
      'type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock',
      '--mount',
      `type=bind,src=${sourceHostDir},dst=/input,readonly`,
      '-e',
      `HAIVE_BUILD_PLAN=${JSON.stringify(plan)}`,
      ...(dockerConfigHostDir
        ? [
            '--mount',
            `type=bind,src=${dockerConfigHostDir},dst=/run/haive-docker-config,readonly`,
            '-e',
            'DOCKER_CONFIG=/run/haive-docker-config',
            '-e',
            'BUILDX_CONFIG=/tmp/buildx',
          ]
        : []),
      image,
    ],
    undefined,
    3_600_000,
  );
}

/** Resolve only the new own-module settings with Compose's .env parser/interpolator.
 * The updater image carries the target version, so installed version/registry and settings
 * must come from the install file rather than the updater's ambient environment. */
export async function resolveImageSettings(
  file: string,
  keys: readonly string[],
): Promise<Record<string, string>> {
  const env = { ...process.env };
  for (const key of [...keys, 'HAIVE_VERSION', 'HAIVE_REGISTRY']) delete env[key];
  const envFile = resolve(file);
  const model = {
    services: {
      settings: {
        image: 'scratch',
        environment: Object.fromEntries(keys.map((key) => [key, '${' + key + '-}'])),
      },
    },
  };
  try {
    const stdout = await new Promise<string>((done, reject) => {
      const child = execFile(
        'docker',
        [
          // Keep Docker's transport config explicit while clearing interpolation precedence.
          ...(keys.includes('DOCKER_CONFIG') && process.env.DOCKER_CONFIG
            ? ['--config', process.env.DOCKER_CONFIG]
            : []),
          'compose',
          '--project-name',
          'updater-settings',
          '--project-directory',
          dirname(envFile),
          '--env-file',
          envFile,
          '-f',
          '-',
          'config',
          '--format',
          'json',
        ],
        { env, timeout: 30_000, maxBuffer: 1024 * 1024 },
        (error, out) => (error ? reject(error) : done(out)),
      );
      child.stdin?.on('error', () => {});
      child.stdin?.end(JSON.stringify(model));
    });
    const values = JSON.parse(stdout)?.services?.settings?.environment as unknown;
    if (!values || typeof values !== 'object' || Array.isArray(values))
      throw new Error('invalid Compose output');
    const result: Record<string, string> = {};
    for (const key of keys) {
      const value = (values as Record<string, unknown>)[key];
      if (typeof value !== 'string') throw new Error('invalid Compose setting');
      // Compose config escapes every dollar for re-reading its serialized model:
      // docker/compose cmd/compose/config.go runConfig. Undo that one transport layer.
      result[key] = value.replaceAll('$$', '$');
    }
    return result;
  } catch {
    // Compose errors can echo .env values. Never send its stderr/command into logs or the journal.
    throw new Error(
      'could not resolve install image settings with Docker Compose; check .env syntax and Compose availability',
    );
  }
}

/** Pull even when cached: revoked credentials and missing remote tags must refuse preflight. */
export async function readReleaseManifestImage(image: string): Promise<string> {
  await run('docker', ['pull', image], undefined, 1_800_000);
  const dir = await mkdtemp(join(tmpdir(), 'updater-release-'));
  const name = containerName(CONTAINER_FAMILY.upgrade, 'manifest', randomUUID());
  let id = name;
  try {
    // A scratch release image has no CMD. This command is never executed.
    id = await run('docker', ['create', '--name', name, image, '/unused']);
    const file = join(dir, 'release.json');
    await run('docker', ['cp', `${id}:/release.json`, file]);
    const read = await readFileNoFollow(dir, 'release.json', {
      strict: true,
      maxBytes: 1024 * 1024,
    });
    if (!read || read.truncated) throw new Error('release manifest is missing or too large');
    return read.data.toString('utf8');
  } finally {
    try {
      await run('docker', ['rm', '-f', id]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
