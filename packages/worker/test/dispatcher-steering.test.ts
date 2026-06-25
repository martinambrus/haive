import { describe, expect, it } from 'vitest';
import { resolveDispatch } from '../src/orchestrator/dispatcher.js';
import type { CliCommandSpec } from '../src/cli-adapters/types.js';

function stubAdapter(supportsSteering: boolean) {
  return {
    supportsCliAuth: true,
    supportsSubagents: true,
    supportsSteering,
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
