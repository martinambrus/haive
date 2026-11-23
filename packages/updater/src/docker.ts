import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { CONTAINER_FAMILY, containerName, INSTALL_LABEL } from '@haive/shared/naming';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, isAbsolute, resolve } from 'node:path';
import {
  RELEASE_BUNDLE_FILES,
  parseReleaseManifest,
  type ReleaseManifest,
} from '@haive/shared/release';
import { bundleHash } from './bundle.js';
import { UpgradeRefusal } from './refusal.js';

const exec = promisify(execFile);

const ONE_SHOT_INSTALL = INSTALL_LABEL;
const ONE_SHOT_ATTEMPT = 'org.haive.updater.attempt';
const ONE_SHOT_ROLE = 'org.haive.updater.role';
export const ONE_SHOT_CHECK_TIMEOUT_MS = 30_000;
export const ONE_SHOT_CHECK_MAX_BUFFER = 1024 * 1024;
const oneShotOwner = new AsyncLocalStorage<{ install: string; attempt: string }>();
/** Attempts whose signal cleanup has started. The upgrade keeps running while the cleanup lists and
 *  removes, so a later phase must not start a child the cleanup's list has already missed. */
const stoppingAttempts = new Set<string>();

/** Scope every one-shot, including preflight builders and recovery, to this install invocation. */
export function withOneShotOwner<T>(install: string, work: () => T): T {
  return oneShotOwner.run({ install, attempt: randomUUID() }, work);
}

function oneShotLabels(role: string): string[] {
  const owner = oneShotOwner.getStore();
  if (!owner) throw new Error('one-shot ownership scope is missing');
  if (stoppingAttempts.has(owner.attempt)) throw new Error('one-shot attempt is stopping');
  return [
    '--label',
    `${ONE_SHOT_INSTALL}=${owner.install}`,
    '--label',
    `${ONE_SHOT_ATTEMPT}=${owner.attempt}`,
    '--label',
    `${ONE_SHOT_ROLE}=${role}`,
  ];
}

/** Called under the install lock, before recovery or upgrade phases. Docker owns the child
 * containers after a client dies; a stale lease is therefore insufficient proof of quiescence. */
export async function requireNoRunningOneShots(
  options: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<void> {
  const owner = oneShotOwner.getStore();
  if (!owner) throw new Error('one-shot ownership scope is missing');
  let stdout: string;
  try {
    ({ stdout } = await exec(
      'docker',
      [
        'ps',
        '--filter',
        `label=${ONE_SHOT_INSTALL}=${owner.install}`,
        '--filter',
        `label=${ONE_SHOT_ATTEMPT}`,
        '--filter',
        `label=${ONE_SHOT_ROLE}`,
        '--format',
        `{{.ID}}\t{{.Label "${ONE_SHOT_ATTEMPT}"}}\t{{.Label "${ONE_SHOT_ROLE}"}}`,
      ],
      {
        timeout: options.timeoutMs ?? ONE_SHOT_CHECK_TIMEOUT_MS,
        maxBuffer: options.maxBuffer ?? ONE_SHOT_CHECK_MAX_BUFFER,
      },
    ));
  } catch (error) {
    const diagnostic = errorCodeOrClass(error);
    throw new UpgradeRefusal(
      'updater-child-check-failed',
      `could not check updater one-shot containers (${diagnostic}); check Docker availability and retry`,
    );
  }
  const blockers = stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [id, attempt, role] = line.split('\t');
      return { id, attempt, role };
    })
    .filter((child) => child.attempt !== owner.attempt);
  if (blockers.length) {
    throw new UpgradeRefusal(
      'updater-child-running',
      `another updater attempt still has running one-shot containers for this install: ${blockers
        .map((child) => `${child.id} (${child.role || 'unknown role'})`)
        .join(
          ', ',
        )}; wait for them to finish, or if a survivor is known dead or hung, remove it with docker rm -f <id>, then retry`,
    );
  }
}

/**
 * Docker transport wrappers. Upgrade decisions live in `phases.ts` and `preflight.ts`;
 * one-shot ownership and the post-lock orphan check live here beside their Docker labels.
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

function errorCodeOrClass(error: unknown): string | number {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code ?? (error instanceof Error ? error.constructor.name : typeof error);
}

/** Capture ownership while registering the handler: process signal callbacks have no owner scope. */
export function oneShotSignalCleanup(): () => Promise<void> {
  const owner = oneShotOwner.getStore();
  if (!owner) throw new Error('one-shot ownership scope is missing');
  return () => {
    stoppingAttempts.add(owner.attempt);
    return stopOneShots(owner.install, owner.attempt);
  };
}

/** A terminated Docker client does not stop its container. Remove only this attempt's role
 * (all its roles on SIGTERM) before its caller can roll back or release the lock. */
async function stopOneShots(
  install: string,
  attempt: string,
  roleLabel = ONE_SHOT_ROLE,
): Promise<void> {
  const options = {
    timeout: ONE_SHOT_CHECK_TIMEOUT_MS,
    maxBuffer: ONE_SHOT_CHECK_MAX_BUFFER,
    killSignal: 'SIGKILL' as const,
  };
  const filters = [
    'ps',
    '-aq',
    '--filter',
    `label=${ONE_SHOT_INSTALL}=${install}`,
    '--filter',
    `label=${ONE_SHOT_ATTEMPT}=${attempt}`,
    '--filter',
    `label=${roleLabel}`,
  ];
  const list = async () => {
    const { stdout } = await exec('docker', filters, options);
    return stdout.split(/\s+/).filter(Boolean);
  };
  try {
    const ids = await list();
    if (ids.length) {
      try {
        await exec('docker', ['rm', '-f', ...ids], options);
      } catch (error) {
        // --rm can win this race. Only a fresh listing with identical filters proves success.
        if ((await list()).length) throw error;
      }
    }
  } catch (error) {
    throw new UpgradeRefusal(
      'updater-child-cleanup-failed',
      `could not stop updater one-shot containers (${errorCodeOrClass(error)}); ` +
        'leave the upgrade for recovery, check Docker availability and retry',
    );
  }
}

async function run(
  cmd: string,
  args: string[],
  cwd?: string,
  timeoutMs = 600_000,
): Promise<string> {
  const roleLabel =
    cmd === 'docker' && args[0] === 'run'
      ? args.find((arg) => arg.startsWith(`${ONE_SHOT_ROLE}=`))
      : undefined;
  const owner = roleLabel ? oneShotOwner.getStore() : undefined;
  try {
    const { stdout } = await exec(cmd, args, {
      cwd,
      // Main's SIGTERM timeout was proxied to PID 1 and did not bound these one-shots.
      // Keep long snapshots, migrations and builds unbounded; SIGKILL still bounds maxBuffer kills.
      timeout: owner ? 0 : timeoutMs,
      ...(owner ? { killSignal: 'SIGKILL' as const } : {}),
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    const failure = err as (NodeJS.ErrnoException & { signal?: string | null }) | null;
    if (
      owner &&
      roleLabel &&
      (failure?.signal != null || failure?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
    ) {
      try {
        await stopOneShots(owner.install, owner.attempt, roleLabel);
      } catch (cleanupError) {
        if (cleanupError instanceof UpgradeRefusal)
          cleanupError.message += `; original client failure: ${errorCodeOrClass(err)}`;
        throw cleanupError;
      }
    }
    throw new Error(redactSecrets(err instanceof Error ? err.message : String(err)));
  }
}

function composeArgs(ctx: ComposeContext, rest: string[]): string[] {
  return [
    ...ctx.files.flatMap((f) => ['-f', f]),
    ...(ctx.files.some(isAbsolute) ? ['--project-directory', ctx.dir] : []),
    ...rest,
  ];
}

/** Compose can echo .env values even on config -q failure. Discard both output and error. */
export async function validateCompose(ctx: ComposeContext, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    await exec('docker', ['compose', ...composeArgs(ctx, ['config', '-q'])], {
      cwd: ctx.dir,
      env,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    throw new UpgradeRefusal(
      'bundle-config-invalid',
      'could not validate staged compose bundle; check .env syntax and Compose availability',
    );
  }
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
      '{{.Repository}}:{{.Tag}}\t{{.Repository}}@{{.Digest}}\t{{.Repository}}:{{.Tag}}@{{.Digest}}',
    ]);
    return [...new Set(out.split(/\s+/).filter((ref) => ref && !ref.includes('<none>')))];
  }
  const out = await run('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}']);
  return out.split('\n').filter(Boolean);
}

export async function pullImages(ctx: ComposeContext, env: NodeJS.ProcessEnv): Promise<void> {
  await runCompose(ctx, env, ['pull']);
}

/** Keep process diagnostics for pull, deployment and rollback failures. */
async function runCompose(
  ctx: ComposeContext,
  env: NodeJS.ProcessEnv,
  args: string[],
  timeout = 1_800_000,
): Promise<void> {
  await exec('docker', ['compose', ...composeArgs(ctx, args)], {
    cwd: ctx.dir,
    env,
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** Bring services up. `services` empty means the whole stack. */
export async function composeUp(
  ctx: ComposeContext,
  env: NodeJS.ProcessEnv,
  services: string[] = [],
  options: { removeOrphans?: boolean } = {},
): Promise<void> {
  await runCompose(ctx, env, [
    'up',
    '-d',
    ...(options.removeOrphans ? ['--remove-orphans'] : []),
    ...services,
  ]);
}

/** Stop services WITHOUT `-v`. Never `-v`: several volumes are globally named and shared with any
 *  other install on the machine, so `-v` would take that install's repositories with it. */
export async function composeStop(
  ctx: ComposeContext,
  env: NodeJS.ProcessEnv,
  services: string[],
): Promise<void> {
  await runCompose(ctx, env, ['stop', ...services], 600_000);
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
    ...oneShotLabels('snapshot'),
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
    ...oneShotLabels('restore'),
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
    ...oneShotLabels('migration'),
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
      ...oneShotLabels('builder'),
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
            '-e',
            'DOCKER_HOST=unix:///var/run/docker.sock',
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

export const MANIFEST_MAX = 1024 * 1024;
export const BUNDLE_FILE_MAX = 256 * 1024;

function singleFileHeaderSize(header: Buffer, expectedName: string, max: number): number {
  const invalid = () => new Error('invalid release manifest tar header');
  const string = (start: number, end: number) => {
    const field = header.subarray(start, end);
    const zero = field.indexOf(0);
    if (zero !== -1 && field.subarray(zero).some((byte) => byte !== 0)) throw invalid();
    return field.subarray(0, zero === -1 ? field.length : zero).toString('latin1');
  };
  const octal = (start: number, end: number) => {
    const value = header.subarray(start, end).toString('latin1');
    if (!/^[0-7]+[\0 ]*$/.test(value)) throw invalid();
    return Number.parseInt(value, 8);
  };
  const sum = header.reduce(
    (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
    0,
  );
  const size = octal(124, 136);
  if (
    sum !== octal(148, 156) ||
    string(0, 100) !== expectedName ||
    string(345, 500) !== '' ||
    string(157, 257) !== '' ||
    (header[156] !== 0 && header[156] !== 48) ||
    size > max
  )
    throw invalid();
  return size;
}

/** Docker emits tar on stdout. Bound it while reading, before retaining any payload, and never
 * extract paths supplied by an image. Only one ordinary entry of the exact name is accepted. */
export async function streamSingleFile(
  id: string,
  path: string,
  expectedName: string,
  max: number,
): Promise<Buffer> {
  // One header, payload rounded up to a block, and two end blocks. Limits are injectable.
  const tarMax = Math.ceil(max / 512) * 512 + 1536;
  return new Promise((done, reject) => {
    const child = spawn('docker', ['cp', `${id}:${path}`, '-'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000,
      killSignal: 'SIGKILL',
    });
    const chunks: Buffer[] = [];
    const header = Buffer.alloc(512);
    let total = 0;
    let size: number | undefined;
    let failure: Error | undefined;
    const fail = (error: Error) => {
      if (failure) return;
      failure = error;
      child.stdout.destroy();
      child.kill('SIGKILL');
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) return;
      if (total + chunk.length > tarMax) {
        fail(new Error('release manifest tar is too large'));
        return;
      }
      if (total < 512) chunk.copy(header, total, 0, Math.min(chunk.length, 512 - total));
      total += chunk.length;
      if (size === undefined && total >= 512) {
        try {
          size = singleFileHeaderSize(header, expectedName, max);
        } catch (error) {
          fail(error as Error);
          return;
        }
      }
      chunks.push(chunk);
    });
    child.stdout.on('error', (error) => fail(error));
    // Do not buffer or expose Docker stderr; it can contain registry credential helper output.
    child.stderr.resume();
    child.stderr.on('error', (error) => fail(error));
    child.on('error', (error) => {
      failure ??= new Error(redactSecrets(error.message));
    });
    child.on('close', (code) => {
      if (failure) {
        reject(failure);
        return;
      }
      if (code !== 0) {
        reject(new Error('could not copy release manifest from image'));
        return;
      }
      const payloadEnd = 512 + (size ?? 0);
      const archiveEnd = 512 + Math.ceil((size ?? 0) / 512) * 512 + 1024;
      if (size === undefined || total < archiveEnd) {
        reject(new Error('release manifest tar is missing or truncated'));
        return;
      }
      const archive = Buffer.concat(chunks, total);
      if (archive.subarray(payloadEnd).some((byte) => byte !== 0)) {
        reject(new Error('release manifest tar contains unexpected entries or padding'));
        return;
      }
      done(archive.subarray(512, payloadEnd));
    });
  });
}

/** Pull even when cached: revoked credentials and missing remote tags must refuse preflight. */
export async function readReleaseManifestImage(
  image: string,
  onCleanupError?: (container: string, error: unknown) => void,
  options: { manifest?: ReleaseManifest; maxManifestBytes?: number; maxBundleBytes?: number } = {},
): Promise<{ text: string; bundle?: Map<string, Buffer> }> {
  await run('docker', ['pull', image], undefined, 1_800_000);
  const name = containerName(CONTAINER_FAMILY.upgrade, 'manifest', randomUUID());
  let id = name;
  let failed = false;
  try {
    // A scratch release image has no CMD. This command is never executed.
    id = await run('docker', ['create', '--name', name, image, '/unused']);
    const text = (
      await streamSingleFile(
        id,
        '/release.json',
        'release.json',
        options.maxManifestBytes ?? MANIFEST_MAX,
      )
    ).toString('utf8');
    // Public callers supply the URL manifest as the trust anchor. Never use the image's hashes
    // instead, even when its release.json differs. Channel callers read everything from this id.
    const manifest = options.manifest ?? parseReleaseManifest(JSON.parse(text));
    if (!manifest.bundle) return { text };
    const bundle = new Map<string, Buffer>();
    for (const name of RELEASE_BUNDLE_FILES) {
      const expected = manifest.bundle.files[name];
      if (!expected) continue;
      try {
        const bytes = await streamSingleFile(
          id,
          `/bundle/${name}`,
          name,
          options.maxBundleBytes ?? BUNDLE_FILE_MAX,
        );
        if (bundleHash(bytes) !== expected) throw new Error('hash mismatch');
        bundle.set(name, bytes);
      } catch {
        throw new UpgradeRefusal(
          'bundle-invalid',
          `release bundle is missing, invalid or has a hash mismatch: ${name}`,
        );
      }
    }
    return { text, bundle };
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // Keep the few-KB release image: a prior presence probe cannot prove ownership when another
    // process may pull the same ref concurrently. Only the manifest container belongs to this read.
    try {
      await run('docker', ['rm', '-f', id]);
    } catch (error) {
      if (!failed) throw error;
      onCleanupError?.(id, error);
    }
  }
}
