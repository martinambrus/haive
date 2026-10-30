import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitClone, handleInit } from '../src/repo/clone.js';
import { gitTimeoutLimits } from '../src/repo/git-exec.js';
import { scanForCredentials } from '../src/step-engine/steps/onboarding/_credential-scan.js';
import { runGit as advanceGit } from '../scripts/advance-bundle-items.js';
import { runGit as resetGit } from '../scripts/reset-bundle-to-commit.js';

vi.mock('@haive/database', async (original) => ({
  ...(await original<typeof import('@haive/database')>()),
  acquireRootClaim: async () => ({ release: async () => {}, lost: () => false }),
}));

// A real owned child, with an independent watchdog. The shim has no subprocesses:
// either production's deadline reaps it or the watchdog kills it before the assertion fails.
describe('remaining Git callers use bounded execution', () => {
  let dir: string;
  const savedEnv = { ...process.env };
  const savedLimits = { ...gitTimeoutLimits };
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let watchdogFired = false;
  const record = () => readFile(path.join(dir, 'call.json'), 'utf8').then(JSON.parse);
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  async function cleanupChild() {
    const call = await record().catch(() => null);
    if (call && alive(call.pid)) process.kill(call.pid, 'SIGKILL');
  }
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'remaining-git-'));
    await writeFile(
      path.join(dir, 'git'),
      `#!${process.execPath}\nconst fs = require('node:fs');
fs.writeFileSync(process.env.T412_CALL, JSON.stringify({pid: process.pid, args: process.argv.slice(2), token: process.env.T412_TOKEN, prompt: process.env.GIT_TERMINAL_PROMPT, askpass: process.env.GIT_ASKPASS}));
if (process.env.T412_MODE === 'killed') process.kill(process.pid, 'SIGKILL');
if (process.env.T412_MODE === 'hang') setInterval(() => {}, 1000);
else { process.stdout.write('ordinary output\\n'); process.stderr.write(process.env.T412_STDERR || ''); process.exit(Number(process.env.T412_EXIT || 0)); }
`,
    );
    await chmod(path.join(dir, 'git'), 0o755);
    process.env.PATH = `${dir}:${savedEnv.PATH}`;
    process.env.T412_CALL = path.join(dir, 'call.json');
    process.env.T412_MODE = 'hang';
    gitTimeoutLimits.long = 200;
    gitTimeoutLimits.short = 200;
    watchdogFired = false;
    watchdog = setTimeout(() => {
      watchdogFired = true;
      void cleanupChild();
    }, 2000);
  });
  afterEach(async () => {
    clearTimeout(watchdog);
    await cleanupChild();
    process.env = { ...savedEnv };
    Object.assign(gitTimeoutLimits, savedLimits);
    await rm(dir, { recursive: true, force: true });
  });

  it.each([
    [
      'clone before destination exists',
      () => gitClone('https://example.test/repo', path.join(dir, 'absent')),
    ],
    [
      'blank init',
      () =>
        handleInit(
          { repositoryId: 'repo', userId: 'user', source: 'blank' },
          {
            select: () => ({
              from: () => ({ where: () => ({ limit: async () => [{ name: 'fixture' }] }) }),
            }),
          } as never,
          dir,
        ),
    ],
    ['advance operator', () => advanceGit(dir, ['rev-parse', 'HEAD'])],
    ['reset operator', () => resetGit(dir, ['reset', '--hard', 'HEAD'])],
  ] as const)('%s terminates and reaps its timed-out child', async (_name, run) => {
    await expect(run()).rejects.toThrow(/exit 124.*timed out/);
    expect(watchdogFired, 'outer watchdog had to terminate an unbounded caller').toBe(false);
    expect(alive((await record()).pid)).toBe(false);
  });

  it('retains the scanner budget and reaps its stalled streamed inventory', async () => {
    const result = await scanForCredentials(dir, 10, () => {}, { timeoutMs: 200 });
    expect(result).toMatchObject({ limited: true, files: 0, hits: [] });
    expect(watchdogFired).toBe(false);
    expect(alive((await record()).pid)).toBe(false);
  });

  it('clone preserves credential argv, trusted env, host destination and normal success', async () => {
    process.env.T412_MODE = 'done';
    await gitClone('https://bad:embedded@example.test/repo', path.join(dir, 'absent'), 'main', {
      argv: ['-c', 'credential.helper=!trusted-helper'],
      env: { T412_TOKEN: 'synthetic-secret' },
      secret: 'synthetic-secret',
    });
    const call = await record();
    expect(call).toMatchObject({ token: 'synthetic-secret', prompt: '0', askpass: 'echo' });
    expect(call.args).toContain('core.hooksPath=/dev/null');
    expect(call.args.indexOf('credential.helper=!trusted-helper')).toBeLessThan(
      call.args.indexOf('clone'),
    );
    expect(call.args.slice(-5)).toEqual([
      '--branch',
      'main',
      '--',
      'https://example.test/repo',
      path.join(dir, 'absent'),
    ]);
    expect(call.args.join(' ')).not.toContain('synthetic-secret');
    expect(call.args.join(' ')).not.toContain('embedded');
  });

  it('clone scrubs the intact known secret before redacting an ordinary failure', async () => {
    process.env.T412_MODE = 'done';
    process.env.T412_EXIT = '7';
    const secret = `pass' suffix`;
    process.env.T412_STDERR = `failed https://u:${secret}@example.test/repo and ${secret}`;
    const error = await gitClone('https://example.test/repo', path.join(dir, 'absent'), undefined, {
      argv: [],
      env: {},
      secret,
    }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('exit 7');
    expect((error as Error).message).not.toContain(secret);
    expect((error as Error).message).not.toContain('suffix');
  });

  it.each([advanceGit, resetGit])(
    'operator keeps normal success and failure payloads',
    async (run) => {
      process.env.T412_MODE = 'done';
      expect(await run(dir, ['rev-parse', 'HEAD'])).toBe('ordinary output');
      process.env.T412_EXIT = '23';
      process.env.T412_STDERR = 'ordinary failure';
      await expect(run(dir, ['rev-parse', 'HEAD'])).rejects.toThrow(/23.*ordinary failure/);
    },
  );
  it.each([
    ['clone', () => gitClone('https://example.test/repo', path.join(dir, 'absent'))],
    ['advance operator', () => advanceGit(dir, ['rev-parse', 'HEAD'])],
    ['reset operator', () => resetGit(dir, ['rev-parse', 'HEAD'])],
  ] as const)(
    '%s preserves no-exit failure instead of treating it as an ordinary exit',
    async (_name, run) => {
      process.env.T412_MODE = 'killed';
      await expect(run()).rejects.toThrow(/exit -1.*without an exit status/);
      expect(alive((await record()).pid)).toBe(false);
      expect(watchdogFired).toBe(false);
    },
  );
});
