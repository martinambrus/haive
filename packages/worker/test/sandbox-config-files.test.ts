import { describe, expect, it, vi } from 'vitest';

// The sandbox is the one boundary faked here, as in codex-app-server-exec.test.ts: the spawner's
// composition of what gets mounted is real.
const runInSandbox = vi.hoisted(() => vi.fn());
const snapshotDb = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../src/db.js', () => ({ getDb: () => snapshotDb.db }));
vi.mock('../src/sandbox/sandbox-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/sandbox-runner.js')>()),
  runInSandbox,
}));

import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import type { PlanChatSnapshot } from '../src/plan/chat-snapshot.js';
import { createSandboxSpawner } from '../src/queues/cli-exec/exec-core.js';
import { GrokAdapter } from '../src/cli-adapters/grok.js';
import { PROMPT_ARGV_LIMIT_BYTES } from '../src/cli-adapters/prompt-delivery.js';
import { SANDBOX_WORKDIR } from '../src/sandbox/sandbox-runner.js';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';

const provider = {
  id: 'prov-grok',
  name: 'grok',
  wrapperPath: null,
  executablePath: null,
  cliArgs: [],
  envVars: {},
  effortLevel: null,
  model: null,
} as unknown as CliProviderRecord;

describe('sandbox spawner: adapter config files', () => {
  it('mounts them after the security masks and before a prompt file', async () => {
    runInSandbox.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1,
      timedOut: false,
      resolvedCommand: 'grok',
      wrapperId: null,
    });
    // An oversized prompt makes grok deliver it as a file, so all three sources are present.
    const spec = new GrokAdapter().buildCliInvocation(
      provider,
      'x'.repeat(PROMPT_ARGV_LIMIT_BYTES + 1),
      {},
    );
    const mask = { containerPath: `${SANDBOX_WORKDIR}/.env`, content: '' };

    await createSandboxSpawner(null, null, null, SANDBOX_WORKDIR, null, [], [mask])(spec);

    // The runner keeps the FIRST claim on a container path, so this order is the precedence
    // rule: a security mask can never be displaced by a config or prompt file.
    const mounted = (
      runInSandbox.mock.calls[0]![0] as { extraFiles: { containerPath: string }[] }
    ).extraFiles.map((f) => f.containerPath);
    expect(mounted).toEqual([
      mask.containerPath,
      '/etc/grok/managed_config.toml',
      spec.promptFile!.containerPath,
    ]);
  });
});

describe('sandbox spawner: snapshot ownership binding', () => {
  const id = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const snapshot: PlanChatSnapshot = {
    schemaVersion: 1,
    userId: id(1),
    repositoryId: id(2),
    taskId: id(3),
    invocationId: id(4),
    nodes: [],
    edges: [],
  };
  it.each([false, true])(
    'rechecks the actual invocation owner before mounting (matching=%s)',
    async (matching) => {
      const fake = createFakeDb({ tasks: schema.tasks, cliInvocations: schema.cliInvocations });
      fake.insert(schema.tasks, {
        id: id(3),
        userId: matching ? id(1) : id(9),
        repositoryId: id(2),
      });
      fake.insert(schema.cliInvocations, {
        id: id(4),
        taskId: id(3),
        supersededAt: null,
        endedAt: null,
      });
      snapshotDb.db = fake.db;
      runInSandbox.mockClear();
      runInSandbox.mockResolvedValue({
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 1,
        timedOut: false,
      });
      const spawn = createSandboxSpawner(
        null,
        null,
        null,
        SANDBOX_WORKDIR,
        null,
        [],
        [],
        [],
        id(3),
        id(4),
      );
      const pending = spawn({ command: 'cli', args: [], env: {}, planSnapshot: snapshot });
      if (!matching) {
        await expect(pending).rejects.toThrow('owned dispatch');
        expect(runInSandbox).not.toHaveBeenCalled();
      } else {
        await pending;
        expect(runInSandbox).toHaveBeenCalledWith(
          expect.objectContaining({ planSnapshot: snapshot }),
          expect.anything(),
        );
      }
    },
  );
});
