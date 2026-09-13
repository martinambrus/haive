import { describe, expect, it } from 'vitest';
import { resolveDispatch } from '../src/orchestrator/dispatcher.js';
import type { CliCommandSpec, EffortDecision } from '../src/cli-adapters/types.js';

function stubAdapter(supportsSteering: boolean, transportReady = true) {
  return {
    supportsCliAuth: true,
    supportsSubagents: true,
    supportsSteering,
    // The per-task half of the capability — codex's app-server verdict. True for every adapter
    // whose transport is stdin NDJSON; parameterised here to cover the codex gate.
    steeringTransportReady: () => transportReady,
    // The dispatcher records the effort that reached the CLI on every plan it builds. This
    // stub is not a BaseCliAdapter subclass, so it has to answer for itself; these tests are
    // about steering, so it answers with the no-effort-knob case.
    effortDecision: (): EffortDecision => ({ level: null, source: 'none' }),
    buildCliInvocation: (
      _p: unknown,
      prompt: string,
      opts: { steeringMode?: boolean },
    ): CliCommandSpec => ({
      command: 'claude',
      args: opts.steeringMode ? ['-p', '--input-format', 'stream-json'] : ['-p', prompt],
      env: {},
      steerable: opts.steeringMode === true,
    }),
  };
}

const reg = (a: ReturnType<typeof stubAdapter>) => ({ has: () => true, get: () => a }) as never;
const providers = [{ id: 'p1', name: 'claude-code', enabled: true }] as never;

const plan = (supportsSteering: boolean, steeringRequested: boolean) =>
  resolveDispatch({
    providers,
    registry: reg(stubAdapter(supportsSteering)),
    steeringRequested,
    input: { kind: 'prompt', prompt: 'hi', capabilities: [] },
    invokeOpts: {},
  });

const isSteerable = (p: ReturnType<typeof resolveDispatch>): boolean =>
  (p.invocation as { spec: CliCommandSpec }).spec.steerable === true;

describe('dispatcher steering gating (truth table)', () => {
  it('requested AND adapter supports steering -> steerable', () => {
    expect(isSteerable(plan(true, true))).toBe(true);
  });

  it('requested but adapter does NOT support steering -> not steerable', () => {
    expect(isSteerable(plan(false, true))).toBe(false);
  });

  it('adapter supports but not requested (global/repo off) -> not steerable', () => {
    expect(isSteerable(plan(true, false))).toBe(false);
  });

  it('requested and supported, but the transport is not ready for this task -> not steerable', () => {
    const p = resolveDispatch({
      providers,
      registry: reg(stubAdapter(true, false)),
      steeringRequested: true,
      input: { kind: 'prompt', prompt: 'hi', capabilities: [] },
      invokeOpts: {},
    });
    expect(isSteerable(p)).toBe(false);
  });

  it('hands the task verdicts to the adapter transport check', () => {
    const seen: unknown[] = [];
    const adapter = {
      ...stubAdapter(true),
      steeringTransportReady: (_provider: unknown, ctx: unknown) => {
        seen.push(ctx);
        return true;
      },
    };
    const verdicts = { p1: { status: 'supported' } } as never;
    resolveDispatch({
      providers,
      registry: reg(adapter as never),
      steeringRequested: true,
      codexAppServer: verdicts,
      input: { kind: 'prompt', prompt: 'hi', capabilities: [] },
      invokeOpts: {},
    });
    expect(seen).toEqual([{ codexAppServer: verdicts }]);
  });

  it('default (no steeringRequested field) -> not steerable', () => {
    const p = resolveDispatch({
      providers,
      registry: reg(stubAdapter(true)),
      input: { kind: 'prompt', prompt: 'hi', capabilities: [] },
      invokeOpts: {},
    });
    expect(isSteerable(p)).toBe(false);
  });
});
