import { expect, it } from 'vitest';
import { resolveDispatch, type DispatchRequest } from '../src/orchestrator/dispatcher.js';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';
const ID = `sha256:${'a'.repeat(64)}`;
const providers = ['codex', 'claude-code'].map(
  (name, i) =>
    ({
      id: `p${i}`,
      userId: 'u',
      name,
      enabled: true,
      createdAt: new Date(i),
      cliVersion: null,
      envVars: null,
      cliArgs: null,
      executablePath: null,
      wrapperPath: null,
      wrapperContent: null,
      supportsSubagents: true,
      authMode: 'subscription',
    }) as CliProviderRecord,
);
const request = (preferredProviderId: string, extra = {}): DispatchRequest => ({
  providers,
  preferredProviderId,
  input: { kind: 'prompt', prompt: 'Check the code', capabilities: [] },
  invokeOpts: {},
  ...extra,
});
it('adds the selected provider image fact and replaces a stored block once', () => {
  const sandboxToolchain = { p0: { imageId: ID, php: 'absent' }, p1: null };
  const req = request('p0', { sandboxToolchain });
  const first = resolveDispatch(req);
  expect(first.effectivePrompt).toContain('<haive_sandbox_toolchain>');
  expect(first.effectivePrompt).toContain('php');
  const second = resolveDispatch({
    ...req,
    input: { kind: 'prompt', prompt: first.effectivePrompt!, capabilities: [] },
  });
  expect(second.effectivePrompt?.match(/<haive_sandbox_toolchain>/g)).toHaveLength(1);
  expect(resolveDispatch(request('p1', { sandboxToolchain })).effectivePrompt).not.toContain(
    '<haive_sandbox_toolchain>',
  );
});
it('keeps unknown, unmapped and shell-less dispatches byte-identical', () => {
  const baseline = resolveDispatch(request('p0')).effectivePrompt;
  expect(resolveDispatch(request('p0', { sandboxToolchain: { p0: null } })).effectivePrompt).toBe(
    baseline,
  );
  const noShell = request('p1', { invokeOpts: { disableTools: true } });
  expect(
    resolveDispatch({ ...noShell, sandboxToolchain: { p1: { imageId: ID, php: 'absent' } } })
      .effectivePrompt,
  ).toBe(resolveDispatch(noShell).effectivePrompt);
});

it('reports a found version for its own provider and clears an old absence on provider change', () => {
  const absent = resolveDispatch(
    request('p0', { sandboxToolchain: { p0: { imageId: ID, php: 'absent' } } }),
  );
  const next = resolveDispatch(
    request('p1', {
      input: { kind: 'prompt', prompt: absent.effectivePrompt!, capabilities: [] },
      sandboxToolchain: { p1: { imageId: ID, php: 'found', version: '8.4.2' } },
    }),
  );
  expect(next.effectivePrompt).toContain('version 8.4.2');
  expect(next.effectivePrompt).not.toContain('PHP is absent');
  const unknown = resolveDispatch(
    request('p1', { input: { kind: 'prompt', prompt: absent.effectivePrompt!, capabilities: [] } }),
  );
  expect(unknown.effectivePrompt).not.toContain('<haive_sandbox_toolchain>');
});
it('gives native and sequential sub-agents and synthesis the same fact and exec recheck identity', () => {
  for (const providerId of ['p0', 'p1']) {
    const plan = resolveDispatch(
      request(providerId, {
        input: {
          kind: 'subagent',
          capabilities: [],
          spec: {
            subAgents: [{ name: 'one', prompt: 'Check one', outputKey: 'one' }],
            synthesisPrompt: 'Combine',
          },
        },
        sandboxToolchain: { [providerId]: { imageId: ID, php: 'absent' } },
      }),
    );
    expect(plan.invocation?.kind).toBe('subagent');
    if (plan.invocation?.kind !== 'subagent') throw new Error('expected sub-agent');
    expect(plan.invocation.spec.sandboxToolchainImageId).toBe(ID);
    expect(plan.invocation.spec.steps[0]?.prompt).toContain('<haive_sandbox_toolchain>');
    expect(plan.invocation.spec.synthesis.prompt).toContain('<haive_sandbox_toolchain>');
  }
});
