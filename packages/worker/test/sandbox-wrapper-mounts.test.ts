import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildMountArgs,
  type DockerRunner,
  type DockerRunOpts,
  type DockerVolumeMount,
} from '../src/sandbox/docker-runner.js';
import { runInSandbox, type SandboxRunSpec } from '../src/sandbox/sandbox-runner.js';

const VOLUME = 'haive_wrappers_mounts_test';
const SANDBOX_ROOT = '/haive/wrappers';
const WRAPPER = 'exec "$@"';
const TOKEN_FILE = '/haive/haive-integrations.token';
const CAPTURE_DIR = '/haive/cli-log';
const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const ran = { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'haive-wrapper-mounts-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A runner that hands what docker would be given to `inspect`, while the run's files are still on disk. */
const recording = (inspect: (opts: DockerRunOpts) => void): DockerRunner =>
  ({
    run: async (opts: DockerRunOpts) => {
      inspect(opts);
      return ran;
    },
  }) as unknown as DockerRunner;

const run = (spec: SandboxRunSpec, docker: DockerRunner, extraMounts?: DockerVolumeMount[]) =>
  runInSandbox(spec, {
    image: 'test-image',
    docker,
    wrapperVolumeName: VOLUME,
    wrapperWorkerPath: root,
    ...(extraMounts ? { extraMounts } : {}),
  });

async function dockerGiven(
  spec: SandboxRunSpec,
  extraMounts?: DockerVolumeMount[],
): Promise<DockerRunOpts> {
  let given: DockerRunOpts | undefined;
  await run(
    spec,
    recording((opts) => (given = opts)),
    extraMounts,
  );
  return given!;
}

const full: SandboxRunSpec = {
  command: 'claude',
  args: ['-p', 'x'],
  wrapperContent: WRAPPER,
  extraFiles: [
    { containerPath: TOKEN_FILE, content: 'token' },
    { containerPath: '/haive/workdir/.env', content: '' },
  ],
  captureDir: { containerDir: CAPTURE_DIR, fileName: 'cli.log' },
};

/** The text of every file in the wrappers tree that a container started with these mounts can open. */
function readable(mounts: readonly DockerVolumeMount[]): string[] {
  const out: string[] = [];
  const walk = (path: string): void => {
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path)) walk(join(path, name));
    } else {
      out.push(readFileSync(path, 'utf8'));
    }
  };
  for (const mount of mounts) if (mount.source === VOLUME) walk(join(root, mount.subpath ?? ''));
  return out;
}

describe('the wrappers volume in a sandbox', () => {
  it('[S1] is never mounted whole', async () => {
    const { mounts } = await dockerGiven(full);
    expect(mounts!.filter((m) => m.source === VOLUME && !m.subpath)).toEqual([]);
  });

  it('[S1] is never mounted whole in the argv docker gets', async () => {
    const { mounts } = await dockerGiven(full);
    const args = buildMountArgs(mounts!);
    expect(args.some((arg) => arg.startsWith(`${VOLUME}:`))).toBe(false);
    const ofVolume = args.filter((arg) => arg.includes(`source=${VOLUME}`));
    expect(ofVolume.length).toBeGreaterThan(0);
    for (const arg of ofVolume) expect(arg).toContain('volume-subpath=');
  });

  it('[S1] is not mounted at all for a run with nothing to place in it, and the mounts of the caller are kept', async () => {
    const own: DockerVolumeMount = { source: '/host/repo', target: '/haive/workdir' };
    const { mounts } = await dockerGiven({ command: 'claude', args: ['-p'] }, [own]);
    expect(mounts).toEqual([own]);
  });

  it('[S2] gives the wrapper script, read-only, a mount of its own at the path the command points to', async () => {
    let given: DockerRunOpts | undefined;
    const result = await run(
      full,
      recording((opts) => (given = opts)),
    );
    const id = result.wrapperId!;
    expect(id).toMatch(new RegExp(`^${ID}$`));
    const path = `${SANDBOX_ROOT}/${id}/wrapper.sh`;
    expect(given!.mounts).toContainEqual({
      source: VOLUME,
      subpath: `${id}/wrapper.sh`,
      target: path,
      readOnly: true,
    });
    expect(given!.cmd).toEqual([path, '-p', 'x']);
    expect(result.resolvedCommand).toBe(path);
  });

  it('[S2] has the wrapper script, executable, behind that mount', async () => {
    let behind: { text: string; mode: number } | undefined;
    await run(
      full,
      recording((opts) => {
        const mount = opts.mounts!.find((m) => m.target.endsWith('/wrapper.sh'));
        expect(mount, 'the mount of the wrapper script').toBeDefined();
        const file = join(root, mount!.subpath!);
        behind = { text: readFileSync(file, 'utf8'), mode: statSync(file).mode & 0o777 };
      }),
    );
    expect(behind).toEqual({ text: `#!/bin/bash\n${WRAPPER}\n`, mode: 0o755 });
  });

  it('[S3] mounts each extra file and the capture dir by subpath, as before', async () => {
    const { mounts } = await dockerGiven(full);
    const rest = mounts!.filter(
      (m) => m.source === VOLUME && m.subpath && !m.target.endsWith('/wrapper.sh'),
    );
    expect(rest).toEqual([
      {
        source: VOLUME,
        subpath: expect.stringMatching(new RegExp(`^${ID}/extra-0$`)),
        target: TOKEN_FILE,
        readOnly: true,
      },
      {
        source: VOLUME,
        subpath: expect.stringMatching(new RegExp(`^${ID}/extra-1$`)),
        target: '/haive/workdir/.env',
        readOnly: true,
      },
      {
        source: VOLUME,
        subpath: expect.stringMatching(new RegExp(`^${ID}$`)),
        target: CAPTURE_DIR,
        readOnly: false,
      },
    ]);
  });
});

describe('two runs at once', () => {
  const TOKENS = { A: 'token-of-the-first-run', B: 'token-of-the-second-run' } as const;
  type Who = keyof typeof TOKENS;

  /** Both runs are past their set-up, so both runs' files are on disk, when each is asked what it could open. */
  async function bothInFlight(): Promise<{ seen: Record<Who, string[]>; whole: string[] }> {
    const arrived: DockerRunOpts[] = [];
    const seen: Partial<Record<Who, string[]>> = {};
    let whole: string[] = [];
    let release!: () => void;
    const together = new Promise<void>((resolve) => (release = resolve));
    const docker = {
      run: async (opts: DockerRunOpts) => {
        arrived.push(opts);
        if (arrived.length === 2) {
          for (const one of arrived) seen[one.env!.WHO as Who] = readable(one.mounts ?? []);
          whole = readable([{ source: VOLUME, target: SANDBOX_ROOT, readOnly: true }]);
          release();
        }
        await together;
        return ran;
      },
    } as unknown as DockerRunner;
    const spec = (who: Who): SandboxRunSpec => ({
      ...full,
      env: { WHO: who },
      wrapperContent: `# ${who}\n${WRAPPER}`,
      extraFiles: [{ containerPath: TOKEN_FILE, content: TOKENS[who] }],
    });
    await Promise.all([run(spec('A'), docker), run(spec('B'), docker)]);
    return { seen: seen as Record<Who, string[]>, whole };
  }

  const holds = (files: string[], text: string) => files.some((file) => file.includes(text));

  it("[S4] cannot open one another's token, each its own", async () => {
    const { seen } = await bothInFlight();
    expect(holds(seen.A, TOKENS.A)).toBe(true);
    expect(holds(seen.B, TOKENS.B)).toBe(true);
    expect(holds(seen.A, TOKENS.B)).toBe(false);
    expect(holds(seen.B, TOKENS.A)).toBe(false);
  });

  it("[S4] cannot open one another's wrapper script, each its own", async () => {
    const { seen } = await bothInFlight();
    expect(holds(seen.A, '# A\n')).toBe(true);
    expect(holds(seen.B, '# B\n')).toBe(true);
    expect(holds(seen.A, '# B\n')).toBe(false);
    expect(holds(seen.B, '# A\n')).toBe(false);
  });

  it('[S4] the check finds both tokens through a mount of the whole volume', async () => {
    const { whole } = await bothInFlight();
    expect(holds(whole, TOKENS.A)).toBe(true);
    expect(holds(whole, TOKENS.B)).toBe(true);
  });
});
