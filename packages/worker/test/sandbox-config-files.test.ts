import { describe, expect, it, vi } from 'vitest';

// The sandbox is the one boundary faked here, as in codex-app-server-exec.test.ts: the spawner's
// composition of what gets mounted is real.
const runInSandbox = vi.hoisted(() => vi.fn());
vi.mock('../src/sandbox/sandbox-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/sandbox-runner.js')>()),
  runInSandbox,
}));

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
