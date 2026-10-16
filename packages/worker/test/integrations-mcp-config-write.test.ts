import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { configService } from '@haive/shared';
import { resolveMcpExtraFiles } from '../src/queues/cli-exec/resolvers.js';
import { clearTaskAuthPreparationState } from '../src/sandbox/task-auth-volume.js';
import type { DockerRunOpts, DockerRunResult } from '../src/sandbox/docker-runner.js';
import { SERVER_NAME, TOKEN_PATH, UNWIRED_REASON } from './support/integrations-contract.js';
import {
  INV_1,
  INV_2,
  STEP_ROW_ID,
  TASK_ID,
  stampedDatabase,
} from './support/integrations-fixtures.js';

vi.mock('../src/lsp/configured-lsp.js', () => ({ hasReadyLspBridge: async () => false }));

const helper = vi.hoisted(() => ({
  exitCode: 0,
  runs: 0,
  script: null as null | ((opts: DockerRunOpts) => DockerRunResult),
}));
vi.mock('../src/sandbox/docker-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sandbox/docker-runner.js')>();
  return {
    ...actual,
    defaultDockerRunner: {
      ...actual.defaultDockerRunner,
      volumeExists: async () => true,
      run: async (opts: DockerRunOpts) => {
        helper.runs += 1;
        return (
          helper.script?.(opts) ?? {
            exitCode: helper.exitCode,
            stdout: '',
            stderr: 'boom',
            durationMs: 1,
            timedOut: false,
          }
        );
      },
    },
  };
});

const run = {
  invocationId: INV_1,
  taskStepId: STEP_ROW_ID,
  timeoutMs: 600_000,
};

const resolve = (db: Database, provider: 'codex' | 'gemini', forRun?: typeof run) =>
  resolveMcpExtraFiles(
    db,
    TASK_ID,
    provider,
    '/haive/workdir',
    'img:tag',
    'full',
    false,
    true,
    null,
    forRun,
  );

const paths = (files: Array<{ containerPath: string }>) => files.map((f) => f.containerPath);

async function failure(attempt: Promise<unknown>): Promise<string> {
  const err = await attempt.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  const message = (err as Error).message;
  expect(message.startsWith(`${UNWIRED_REASON}: `)).toBe(true);
  return message;
}

beforeEach(() => {
  process.env.CONFIG_ENCRYPTION_KEY = 'integrations-mcp-config-write-test-secret';
  delete process.env.RAG_API_INTERNAL_URL;
  helper.exitCode = 0;
  helper.runs = 0;
  helper.script = null;
  clearTaskAuthPreparationState(TASK_ID);
  vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
  vi.spyOn(configService, 'getNumber').mockImplementation(async (_key, fallback = 0) => fallback);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CONFIG_ENCRYPTION_KEY;
  clearTaskAuthPreparationState(TASK_ID);
});

describe.each(['codex', 'gemini'] as const)(
  'a stamped run, through the real writer of its CLI configuration, for %s',
  (provider) => {
    it('[W3] fails when the helper cannot write the configuration, and the retry writes it', async () => {
      helper.exitCode = 1;
      await failure(resolve(stampedDatabase(), provider, run));

      helper.exitCode = 0;
      const { files } = await resolve(stampedDatabase(), provider, { ...run, invocationId: INV_2 });
      expect(paths(files)).toContain(TOKEN_PATH);
      expect(helper.runs).toBe(2);
    });

    it('[W2] goes on, without a second helper run, for another invocation of the task, whose entry is the same', async () => {
      const first = await resolve(stampedDatabase(), provider, run);
      expect(paths(first.files)).toContain(TOKEN_PATH);
      expect(helper.runs).toBe(1);

      const second = await resolve(stampedDatabase(), provider, { ...run, invocationId: INV_2 });
      expect(paths(second.files)).toContain(TOKEN_PATH);
      expect(helper.runs).toBe(1);
    });

    it('[W3] lets a run with no stamp go on when the helper fails', async () => {
      helper.exitCode = 1;
      const { files } = await resolve(stampedDatabase(null), provider, run);
      expect(paths(files)).not.toContain(TOKEN_PATH);
      expect(helper.runs).toBe(1);
    });
  },
);

// The helper script under a real sh, the sandbox home on a temp dir, a stub codex failing one add.
describe('a stamped run whose mcp add fails, through the real helper script, for codex', () => {
  let root: string;
  let exits: Array<number | null>;

  const failAddOf = (name: string): void => {
    helper.script = (opts) => {
      const done = spawnSync(
        'sh',
        ['-c', opts.cmd[2]!.replaceAll('/home/node', join(root, 'home'))],
        {
          env: { PATH: `${join(root, 'bin')}:/usr/bin:/bin`, STUB_FAIL: name },
          encoding: 'utf8',
        },
      );
      exits.push(done.status);
      return {
        exitCode: done.status ?? 1,
        stdout: done.stdout,
        stderr: done.stderr,
        durationMs: 1,
        timedOut: false,
      };
    };
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'haive-integrations-mcp-config-'));
    mkdirSync(join(root, 'bin'));
    mkdirSync(join(root, 'home', '.codex'), { recursive: true });
    const stubs = {
      runuser: ['shift 3', 'exec "$@"'],
      chown: ['exit 0'],
      codex: [
        'if [ "$2" = add ]; then',
        '  for arg in "$@"; do',
        '    [ "$arg" = "$STUB_FAIL" ] && exit 1',
        '  done',
        'fi',
        'exit 0',
      ],
    };
    for (const [name, lines] of Object.entries(stubs)) {
      const file = join(root, 'bin', name);
      writeFileSync(file, `#!/bin/sh\n${lines.join('\n')}\n`);
      chmodSync(file, 0o755);
    }
    exits = [];
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('[W3] fails the run when the add of haive-integrations fails, and the retry writes it', async () => {
    failAddOf(SERVER_NAME);
    await failure(resolve(stampedDatabase(), 'codex', run));
    expect(exits).toEqual([1]);

    failAddOf('');
    const { files } = await resolve(stampedDatabase(), 'codex', { ...run, invocationId: INV_2 });
    expect(paths(files)).toContain(TOKEN_PATH);
    expect(exits).toEqual([1, 0]);
  });

  it('[W3] lets a run with no stamp go on when an add fails', async () => {
    failAddOf('filesystem');
    const { files } = await resolve(stampedDatabase(null), 'codex', run);
    expect(paths(files)).not.toContain(TOKEN_PATH);
    expect(exits).toEqual([1]);
  });
});
