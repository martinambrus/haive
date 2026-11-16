import { beforeEach, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import type { CliExecJobPayload } from '@haive/shared';
import type { CliCommandSpec, SubAgentInvocation } from '../src/cli-adapters/types.js';
import { buildAmpSequentialInvocation } from '../src/sub-agent-emulator/amp-mode.js';
import { buildCodexSequentialInvocation } from '../src/sub-agent-emulator/codex-mode.js';
import { withSandboxToolchain } from '../src/sandbox/toolchain-prompt.js';
const h = vi.hoisted(() => ({ specs: [] as CliCommandSpec[] }));
vi.mock('../src/queues/cli-exec/exec-core.js', () => ({
  executeCliSpec: async (spec: CliCommandSpec) => {
    h.specs.push(spec);
    return {};
  },
  createSandboxSpawner: vi.fn(),
}));
vi.mock('../src/queues/cli-exec/images.js', () => ({
  resolveSandboxImageTag: async () => 'image:tag',
}));
vi.mock('../src/queues/cli-exec/resolvers.js', () => ({
  resolveAuthMounts: async () => [],
  resolveEffectiveEgressDomains: () => [],
  resolveMcpExtraFiles: async () => ({ files: [], extraArgs: [] }),
}));
vi.mock('../src/queues/cli-exec/app-reach.js', () => ({ resolveAppReach: async () => null }));
vi.mock('../src/queues/cli-exec/running-usage.js', () => ({ makeUsageSnapshotPersister: vi.fn() }));
vi.mock('../src/cli-executor/index.js', () => ({
  defaultCliSpawner: vi.fn(),
  runSequentialSubAgent: async (
    invocation: SubAgentInvocation,
    build: (prompt: string) => CliCommandSpec,
  ) => {
    h.specs.push(...[...invocation.steps, invocation.synthesis].map((step) => build(step.prompt)));
    return { exitCode: 0, trace: [], collected: {}, synthesis: null };
  },
}));
import {
  executeSubAgentNative,
  executeSubAgentSequential,
} from '../src/queues/cli-exec/sub-agent.js';
import { defaultDeps } from '../src/queues/cli-exec/_shared.js';
const ID = `sha256:${'a'.repeat(64)}`;
const fact = { imageId: ID, php: 'absent' as const };
const provider = {
  id: 'p',
  name: 'claude-code',
  envVars: null,
  cliArgs: null,
  authMode: 'subscription',
};
const db = { query: { cliProviders: { findFirst: async () => provider } } } as unknown as Database;
beforeEach(() => {
  h.specs.length = 0;
  provider.name = 'claude-code';
});
async function run(mode: 'native' | 'sequential', prompts: string[]) {
  const invocation: SubAgentInvocation = {
    mode,
    steps: prompts.slice(0, -1).map((prompt, i) => ({
      id: `agent-${i}`,
      collectInto: `out-${i}`,
      prompt,
      expectJsonOutput: false,
    })),
    synthesis: { id: 'synthesis', prompt: prompts.at(-1)!, expectJsonOutput: false },
    sandboxToolchainImageId: ID,
  };
  const payload = { cliProviderId: 'p', spec: invocation } as unknown as CliExecJobPayload;
  if (mode === 'native')
    await executeSubAgentNative(db, payload, defaultDeps, {}, null, '/work', [], [], false, false);
  else await executeSubAgentSequential(db, payload, {}, null, '/work', [], [], false, false);
}
it('stamps the actual native copy count and skips full quotes between owned copies', async () => {
  const block = withSandboxToolchain('', fact);
  await run('native', [
    withSandboxToolchain(`Quote:\n${block}Keep it.`, fact),
    withSandboxToolchain('Combine', fact),
  ]);
  expect(h.specs[0]?.sandboxToolchain).toMatchObject({
    imageId: ID,
    copies: 2,
    occurrences: [1, 3],
  });
});
it.each(['native', 'sequential'] as const)(
  'never stamps a missing %s block and rebuilds without other owned advisories',
  async (mode) => {
    await run(
      mode,
      mode === 'native' ? [withSandboxToolchain('Check code', fact), 'No fact'] : ['No fact'],
    );
    for (const spec of h.specs) {
      expect(spec.sandboxToolchain).toBeUndefined();
      expect(JSON.stringify(spec)).not.toContain('haive_sandbox_toolchain');
    }
  },
);

it.each(['codex', 'amp'] as const)(
  'normalizes an older queued %s wrapper before stamping, preserving full quotes',
  async (kind) => {
    if (kind === 'amp') provider.name = 'amp';
    const body = `Quoted advisory:\n${withSandboxToolchain('', fact)}Keep this quote.`;
    const old = (kind === 'amp' ? buildAmpSequentialInvocation : buildCodexSequentialInvocation)({
      subAgents: [
        { name: 'agent-0', outputKey: 'out-0', prompt: withSandboxToolchain(body, fact) },
      ],
      synthesisPrompt: withSandboxToolchain('Combine', fact),
    });
    await run('sequential', [old.steps[0]!.prompt, old.synthesis.prompt]);
    expect(h.specs).toHaveLength(2);
    for (const spec of h.specs)
      expect(spec.sandboxToolchain).toMatchObject({ imageId: ID, copies: 1 });
    const sent =
      h.specs[0]!.stdinPrompt ?? h.specs[0]!.args.find((arg) => arg.includes('Quoted advisory:'))!;
    expect(sent).toContain(body);
    expect(sent.split('<haive_sandbox_toolchain>')).toHaveLength(3);
  },
);
