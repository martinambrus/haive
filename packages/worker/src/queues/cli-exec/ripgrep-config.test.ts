import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DockerVolumeMount } from '../../sandbox/docker-runner.js';
import { resolveRipgrepConfigEnv, workerRootForMount } from './ripgrep-config.js';
import { WORKER_REPO_STORAGE_ROOT } from './resolvers.js';

// ripgrep reads a config ONLY from RIPGREP_CONFIG_PATH — never from a `.ripgreprc` in the
// cwd. VERIFIED on rg 14.1.0: file in cwd + variable unset, `rg -t php` matched nothing in
// a `.inc`; variable pointing at the same file, it matched. Without this the whole of
// 01_5-ripgrep-config was inert.
describe('workerRootForMount', () => {
  it('joins the storage root to a volume mount subpath', () => {
    const mount = { source: 'haive_repos', target: '/w', subpath: 'u/r' } as DockerVolumeMount;
    expect(workerRootForMount(mount)).toBe(path.posix.join(WORKER_REPO_STORAGE_ROOT, 'u/r'));
  });

  it('uses the source directory for a bind-mounted local repo', () => {
    const mount = { source: '/host-fs/proj', target: '/w' } as DockerVolumeMount;
    expect(workerRootForMount(mount)).toBe('/host-fs/proj');
  });

  it('is null when the mount names no place to look', () => {
    expect(workerRootForMount({ source: '', target: '/w' } as DockerVolumeMount)).toBeNull();
  });
});

describe('resolveRipgrepConfigEnv', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'haive-rgcfg-'));
    await mkdir(path.join(dir, 'with'), { recursive: true });
    await mkdir(path.join(dir, 'without'), { recursive: true });
    await writeFile(path.join(dir, 'with', '.ripgreprc'), '--type-add=php:*.inc\n');
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const mountAt = (p: string, target = '/haive/workdir'): DockerVolumeMount =>
    ({ source: p, target }) as DockerVolumeMount;

  it('exports the CONTAINER path when the worker can see the file', async () => {
    const env = await resolveRipgrepConfigEnv(mountAt(path.join(dir, 'with')));
    expect(env).toEqual({ RIPGREP_CONFIG_PATH: '/haive/workdir/.ripgreprc' });
  });

  // Pointed at a missing file ripgrep warns on EVERY invocation (126 bytes to stderr,
  // measured), which an agent can read as a failure. Silence is the correct output here.
  it('sets nothing when the repo generated no config', async () => {
    expect(await resolveRipgrepConfigEnv(mountAt(path.join(dir, 'without')))).toEqual({});
  });

  it('sets nothing when there is no repo mount at all', async () => {
    expect(await resolveRipgrepConfigEnv(null)).toEqual({});
  });

  it('never points at a directory that merely shares the name', async () => {
    const decoy = path.join(dir, 'decoy');
    await mkdir(path.join(decoy, '.ripgreprc'), { recursive: true });
    expect(await resolveRipgrepConfigEnv(mountAt(decoy))).toEqual({});
  });

  it('honours the mount target, so a non-default workdir still resolves', async () => {
    const env = await resolveRipgrepConfigEnv(mountAt(path.join(dir, 'with'), '/srv/app'));
    expect(env).toEqual({ RIPGREP_CONFIG_PATH: '/srv/app/.ripgreprc' });
  });
});
