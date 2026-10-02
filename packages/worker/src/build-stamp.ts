import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDevVersion, logger } from '@haive/shared';
import { gitExec } from './repo/git-exec.js';

const UNKNOWN = 'unknown';
const DEFAULT_TIMEOUT_MS = 30_000;
const OBJECT_ID = /^[0-9a-f]{40}$/;

let stamp: string | null = null;
let started: Promise<string> | undefined;

const exists = (target: string): Promise<boolean> =>
  lstat(target).then(
    () => true,
    () => false,
  );

function objectId(output: string): string {
  const id = output.trim();
  if (!OBJECT_ID.test(id)) throw new Error('git did not answer with a 40-hex object id');
  return id;
}

async function checkoutTop(startDir: string): Promise<string | null> {
  for (let dir = path.resolve(startDir); ; dir = path.dirname(dir)) {
    if (await exists(path.join(dir, '.git'))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

async function gitStamp(top: string, env: NodeJS.ProcessEnv, deadline: number): Promise<string> {
  const git = async (args: string[], gitEnv: NodeJS.ProcessEnv = env): Promise<string> => {
    const timeout = deadline - Date.now();
    if (timeout <= 0) throw new Error('build stamp timed out');
    return (await gitExec(args, { cwd: top, env: gitEnv, timeout })).stdout;
  };

  let head: string | null = null;
  try {
    head = objectId(await git(['rev-parse', '--verify', '-q', 'HEAD']));
  } catch (err) {
    if ((err as { code?: unknown }).code !== 1) throw err;
  }
  const headTree =
    head === null ? null : objectId(await git(['rev-parse', '--verify', 'HEAD^{tree}']));

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'build-stamp-'));
  try {
    await mkdir(path.join(tmp, 'objects'));
    // Alternates serve only the seed read: a write through them touches the real object files.
    const scratch = {
      ...env,
      GIT_INDEX_FILE: path.join(tmp, 'index'),
      GIT_OBJECT_DIRECTORY: path.join(tmp, 'objects'),
    };
    // Split index off: a repository that enables it would get a sharedindex file in its .git.
    const index = (args: string[], indexEnv: NodeJS.ProcessEnv = scratch): Promise<string> =>
      git(['-c', 'core.splitIndex=false', ...args], indexEnv);

    // Seeded from HEAD: with core.fileMode or core.symlinks off, add keeps the mode of an entry.
    if (head !== null) {
      const objects = path.resolve(top, (await git(['rev-parse', '--git-path', 'objects'])).trim());
      // C-quoted: the variable is a colon-separated list, so a bare path with a colon splits.
      const alternates = `"${objects.replace(/["\\]/g, '\\$&')}"`;
      await index(['read-tree', head], {
        ...scratch,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates,
      });
    }
    await index(['add', '-A']);
    const forced = (await git(['ls-files', '-ci', '--exclude-standard', '-z']))
      .split('\0')
      .filter(Boolean);
    const present: string[] = [];
    for (const file of forced) if (await exists(path.join(top, file))) present.push(file);
    if (present.length > 0) await index(['--literal-pathspecs', 'add', '-f', '--', ...present]);

    const tree = objectId(await index(['write-tree']));
    return tree === headTree ? `commit:${head}` : `tree:${tree}`;
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function computeBuildStamp(opts: {
  startDir: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<string> {
  try {
    const env = opts.env ?? process.env;
    const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const top = await checkoutTop(opts.startDir);
    if (top !== null) return await gitStamp(top, env, deadline);
    const version = env.HAIVE_VERSION;
    return version && !isDevVersion(version) ? `release:${version}` : UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

export function initBuildStamp(): Promise<string> {
  started ??= computeBuildStamp({ startDir: path.dirname(fileURLToPath(import.meta.url)) }).then(
    (value) => {
      stamp = value;
      logger.info({ buildStamp: value }, 'haive build stamp');
      return value;
    },
  );
  return started;
}

export function currentBuildStamp(): string | null {
  return stamp;
}
