import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
export async function localImages(): Promise<string[]> {
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
