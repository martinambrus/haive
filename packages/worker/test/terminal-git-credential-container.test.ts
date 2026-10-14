import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type Docker from 'dockerode';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { DEFAULT_GIT_CRED_TOKEN_TTL_SECONDS, verifyRepoGitCredToken } from '@haive/shared';
import { SANDBOX_USER_HOME } from '../src/sandbox/sandbox-runner.js';

const log = vi.hoisted(() => {
  const spy = {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => spy,
  };
  return spy;
});

vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  logger: log,
}));
vi.mock('../src/queues/cli-exec-queue.js', () => ({
  resolveSandboxImageTag: async () => 'haive-sandbox:test',
}));

import {
  GIT_CRED_HELPER_JS,
  GIT_CRED_HELPER_PATH,
  GIT_CRED_TOKEN_PATH,
  ensureShellContainer,
} from '../src/terminal/terminal-container.js';

const SECRET = 'git-credential-container-test-secret';
const USER = 'user-1';
const REPO = 'repo-1';
const TASK = 'task-1';

interface ExecRecord {
  cmd: string[];
  stdin: string;
}

interface Fake {
  docker: Docker;
  execs: ExecRecord[];
  created: Array<{ Env: string[] }>;
}

/** A docker that keeps each exec's stdin; `failWrite` makes the exec writing that path exit 1. */
function fakeDocker(opts: { existing: boolean; failWrite?: string }): Fake {
  let running = opts.existing;
  const execs: ExecRecord[] = [];
  const created: Array<{ Env: string[] }> = [];
  const container = {
    inspect: async () => {
      if (!running) throw Object.assign(new Error('no such container'), { statusCode: 404 });
      return { State: { Running: true } };
    },
    remove: async () => undefined,
    start: async () => undefined,
    exec: async (o: { Cmd: string[] }) => {
      const record: ExecRecord = { cmd: o.Cmd, stdin: '' };
      execs.push(record);
      return {
        start: async (s: { stdin?: boolean }) => {
          const stream = new PassThrough();
          stream.on('data', (d: Buffer) => {
            record.stdin += d.toString('utf8');
          });
          if (!s.stdin) setImmediate(() => stream.end());
          return stream;
        },
        inspect: async () => ({
          ExitCode: opts.failWrite && script(record).includes(opts.failWrite) ? 1 : 0,
        }),
      };
    },
  };
  const docker = {
    getContainer: () => container,
    createContainer: async (o: { Env: string[] }) => {
      created.push(o);
      running = true;
      return container;
    },
    getNetwork: () => ({ connect: async () => undefined }),
  } as unknown as Docker;
  return { docker, execs, created };
}

const script = (e: ExecRecord): string => e.cmd.join(' ');
const expOf = (token: string): number =>
  (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { exp: number })
    .exp;
const writesTo = (execs: ExecRecord[], target: string): ExecRecord[] =>
  execs.filter((e) => script(e).includes('cat >') && script(e).includes(target));
const gitConfigs = (execs: ExecRecord[]): string[][] =>
  execs.filter((e) => e.cmd[0] === 'git').map((e) => e.cmd);
const tokenWrite = (execs: ExecRecord[]): ExecRecord => {
  const writes = writesTo(execs, GIT_CRED_TOKEN_PATH);
  expect(writes).toHaveLength(1);
  return writes[0]!;
};

const provider = {
  id: 'prov-1',
  userId: USER,
  name: 'claude-code',
  cliVersion: null,
  sandboxDockerfileExtra: null,
  authMode: 'subscription',
  isolateAuth: false,
};
const db = { query: { cliProviders: { findFirst: async () => provider } } } as unknown as Database;

function ensure(fake: Fake, scope: 'task' | 'repo') {
  return ensureShellContainer({
    db,
    docker: fake.docker,
    userId: USER,
    scope,
    scopeId: scope === 'repo' ? REPO : TASK,
    providerId: provider.id,
    repoMount: null,
    mcpServers: [],
  });
}

/** Everything the module logged, errors flattened since JSON.stringify drops an Error's fields. */
function logged(): string {
  const calls = [log.warn, log.info, log.error, log.debug].flatMap((fn) => fn.mock.calls);
  return JSON.stringify(calls, (_key, value: unknown) =>
    value instanceof Error
      ? { name: value.name, message: value.message, stack: value.stack }
      : value,
  );
}

const savedSecret = process.env.CONFIG_ENCRYPTION_KEY;
const savedApi = process.env.RAG_API_INTERNAL_URL;
const scratch: string[] = [];

beforeEach(() => {
  process.env.CONFIG_ENCRYPTION_KEY = SECRET;
  delete process.env.RAG_API_INTERNAL_URL;
  for (const fn of [log.warn, log.info, log.error, log.debug]) fn.mockClear();
});

afterEach(() => {
  if (savedSecret === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
  else process.env.CONFIG_ENCRYPTION_KEY = savedSecret;
  if (savedApi === undefined) delete process.env.RAG_API_INTERNAL_URL;
  else process.env.RAG_API_INTERNAL_URL = savedApi;
});

afterAll(async () => {
  await Promise.all(scratch.map((d) => rm(d, { recursive: true, force: true })));
});

describe('a new repo-scope shell container', () => {
  it('keeps the credential URL in its env but not the token', async () => {
    const fake = fakeDocker({ existing: false });
    await ensure(fake, 'repo');
    const env = fake.created[0]!.Env;
    expect(env).toContain('HAIVE_GIT_CRED_URL=http://api:3001/internal/git-credential');
    expect(env.filter((e) => e.startsWith('HAIVE_GIT_CRED_TOKEN'))).toEqual([]);
  });

  it('gets the helper and a token file holding a token minted for that repo and user', async () => {
    const before = Date.now();
    const fake = fakeDocker({ existing: false });
    const result = await ensure(fake, 'repo');
    expect(verifyRepoGitCredToken(tokenWrite(fake.execs).stdin, SECRET)).toEqual({
      repositoryId: REPO,
      userId: USER,
    });
    expect(writesTo(fake.execs, GIT_CRED_HELPER_PATH).map((e) => e.stdin)).toEqual([
      GIT_CRED_HELPER_JS,
    ]);
    expect(result.created).toBe(true);
    expect(result.gitCredMintedAt).toBeGreaterThanOrEqual(before);
    expect(result.gitCredMintedAt).toBeLessThanOrEqual(Date.now());
  });

  it('writes the token file private to its owner', async () => {
    const fake = fakeDocker({ existing: false });
    await ensure(fake, 'repo');
    expect(script(tokenWrite(fake.execs))).toContain('umask 077');
  });

  it('points git at the helper', async () => {
    const fake = fakeDocker({ existing: false });
    await ensure(fake, 'repo');
    expect(gitConfigs(fake.execs)).toEqual([
      ['git', 'config', '--global', 'credential.helper', `!node ${GIT_CRED_HELPER_PATH}`],
    ]);
  });

  it('never puts the token on a command line', async () => {
    const fake = fakeDocker({ existing: false });
    await ensure(fake, 'repo');
    const token = tokenWrite(fake.execs).stdin;
    expect(token).not.toBe('');
    expect(fake.execs.filter((e) => script(e).includes(token))).toEqual([]);
  });
});

describe('a reused repo-scope shell container', () => {
  it('gets a freshly minted token file and a rewritten helper, and no new container', async () => {
    const before = Date.now();
    const fake = fakeDocker({ existing: true });
    const result = await ensure(fake, 'repo');
    expect(result.created).toBe(false);
    expect(fake.created).toEqual([]);
    expect(verifyRepoGitCredToken(tokenWrite(fake.execs).stdin, SECRET)).toEqual({
      repositoryId: REPO,
      userId: USER,
    });
    expect(writesTo(fake.execs, GIT_CRED_HELPER_PATH).map((e) => e.stdin)).toEqual([
      GIT_CRED_HELPER_JS,
    ]);
    expect(result.gitCredMintedAt).toBeGreaterThanOrEqual(before);
    expect(result.gitCredMintedAt).toBeLessThanOrEqual(Date.now());
  });

  it('leaves the git config alone, which the user may have changed since', async () => {
    const fake = fakeDocker({ existing: true });
    await ensure(fake, 'repo');
    expect(gitConfigs(fake.execs)).toEqual([]);
  });

  it('mints a token that expires a full TTL from now', async () => {
    const fake = fakeDocker({ existing: true });
    await ensure(fake, 'repo');
    const exp = expOf(tokenWrite(fake.execs).stdin);
    expect(Math.abs(exp - (Date.now() / 1000 + DEFAULT_GIT_CRED_TOKEN_TTL_SECONDS))).toBeLessThan(
      60,
    );
  });

  it('mints a new token on every reuse, however much later', async () => {
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    try {
      const fake = fakeDocker({ existing: true });
      await ensure(fake, 'repo');
      offset = 7 * 60 * 60 * 1000;
      await ensure(fake, 'repo');
      const writes = writesTo(fake.execs, GIT_CRED_TOKEN_PATH);
      expect(writes).toHaveLength(2);
      const [first, second] = writes.map((e) => expOf(e.stdin));
      expect(second! - first!).toBeGreaterThanOrEqual(7 * 60 * 60 - 5);
    } finally {
      clock.mockRestore();
    }
  });
});

describe('a task-scope shell container', () => {
  it.each([false, true])(
    'gets no credential helper, token or env (existing: %s)',
    async (existing) => {
      const fake = fakeDocker({ existing });
      const result = await ensure(fake, 'task');
      expect(writesTo(fake.execs, GIT_CRED_TOKEN_PATH)).toEqual([]);
      expect(writesTo(fake.execs, GIT_CRED_HELPER_PATH)).toEqual([]);
      expect(
        fake.created.flatMap((c) => c.Env).filter((e) => e.startsWith('HAIVE_GIT_CRED')),
      ).toEqual([]);
      expect(result.gitCredMintedAt).toBeUndefined();
    },
  );
});

describe('a repo-scope shell container without CONFIG_ENCRYPTION_KEY', () => {
  it.each([false, true])(
    'gets no credential helper, token or env (existing: %s)',
    async (existing) => {
      delete process.env.CONFIG_ENCRYPTION_KEY;
      const fake = fakeDocker({ existing });
      const result = await ensure(fake, 'repo');
      expect(writesTo(fake.execs, GIT_CRED_TOKEN_PATH)).toEqual([]);
      expect(writesTo(fake.execs, GIT_CRED_HELPER_PATH)).toEqual([]);
      expect(
        fake.created.flatMap((c) => c.Env).filter((e) => e.startsWith('HAIVE_GIT_CRED')),
      ).toEqual([]);
      expect(result.gitCredMintedAt).toBeUndefined();
    },
  );
});

describe.each([false, true])('a failed token write (existing: %s)', (existing) => {
  it('is logged without the token and does not fail the open', async () => {
    const fake = fakeDocker({ existing, failWrite: GIT_CRED_TOKEN_PATH });
    const result = await ensure(fake, 'repo');
    const token = tokenWrite(fake.execs).stdin;
    expect(token).not.toBe('');
    expect(result.gitCredMintedAt).toBeUndefined();
    expect(log.warn.mock.calls.length).toBeGreaterThan(0);
    expect(logged()).not.toContain(token);
    expect(logged()).not.toContain(SECRET);
  });
});

describe('what the container logs on the way through', () => {
  it.each([false, true])('never holds a token (existing: %s)', async (existing) => {
    const fake = fakeDocker({ existing });
    await ensure(fake, 'repo');
    const token = tokenWrite(fake.execs).stdin;
    expect(token).not.toBe('');
    expect(logged()).not.toContain(token);
    expect(logged()).not.toContain(SECRET);
  });
});

/** Runs the exec that writes `target` in a real shell, with the home swapped for a temp dir. */
async function inScratchHome(
  target: string,
  run: (home: string, command: string) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'haive-git-cred-write-'));
  scratch.push(home);
  const fake = fakeDocker({ existing: false });
  await ensure(fake, 'repo');
  const writes = writesTo(fake.execs, target);
  expect(writes).toHaveLength(1);
  await run(home, writes[0]!.cmd[2]!.replaceAll(SANDBOX_USER_HOME, home));
}

describe.each([
  { what: 'token file', target: GIT_CRED_TOKEN_PATH },
  { what: 'helper script', target: GIT_CRED_HELPER_PATH },
])('the command that writes the $what', ({ target }) => {
  it('leaves exactly the content and no temp file', async () => {
    const name = path.basename(target);
    await inScratchHome(target, async (home, command) => {
      expect(spawnSync('sh', ['-c', command], { input: 'content-one' }).status).toBe(0);
      expect(await readFile(path.join(home, name), 'utf8')).toBe('content-one');
      expect(await readdir(home)).toEqual([name]);
    });
  });

  it('replaces an earlier file with the new content', async () => {
    const name = path.basename(target);
    await inScratchHome(target, async (home, command) => {
      for (const content of ['content-one', 'content-two']) {
        expect(spawnSync('sh', ['-c', command], { input: content }).status).toBe(0);
      }
      expect(await readFile(path.join(home, name), 'utf8')).toBe('content-two');
      expect(await readdir(home)).toEqual([name]);
    });
  });

  it('keeps the earlier content readable until the new content has all arrived', async () => {
    const name = path.basename(target);
    await inScratchHome(target, async (home, command) => {
      expect(spawnSync('sh', ['-c', command], { input: 'content-one' }).status).toBe(0);
      const writer = spawn('sh', ['-c', command], { stdio: ['pipe', 'ignore', 'ignore'] });
      const closed = new Promise((resolve) => writer.on('close', resolve));
      try {
        await vi.waitFor(async () => expect(await readdir(home)).toHaveLength(2), {
          timeout: 10_000,
          interval: 20,
        });
        expect(await readFile(path.join(home, name), 'utf8')).toBe('content-one');
      } finally {
        writer.stdin.end('content-two');
        await closed;
      }
      expect(await readFile(path.join(home, name), 'utf8')).toBe('content-two');
    });
  });
});

describe('the command that writes the token file', () => {
  it('creates the file 0600 even under a permissive umask', async () => {
    await inScratchHome(GIT_CRED_TOKEN_PATH, async (home, command) => {
      expect(spawnSync('sh', ['-c', `umask 022; ${command}`], { input: 'token-one' }).status).toBe(
        0,
      );
      expect((await stat(path.join(home, path.basename(GIT_CRED_TOKEN_PATH)))).mode & 0o777).toBe(
        0o600,
      );
    });
  });
});
