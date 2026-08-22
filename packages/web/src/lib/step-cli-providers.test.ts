import { describe, expect, it } from 'vitest';
import { stepCliProviderIds, type StepCliProviderSource } from './step-cli-providers';

const ENABLED = new Set(['codex', 'claude', 'gemini']);

const step = (over: Partial<StepCliProviderSource> = {}): StepCliProviderSource => ({
  preferredCliProviderId: null,
  ...over,
});

const seats = [
  { id: 'peer-reviewer', label: 'Peer Reviewer' },
  { id: 'security-code-reviewer', label: 'Security Code Reviewer' },
];

describe('stepCliProviderIds', () => {
  it('names just the task provider for a step with nothing configured', () => {
    expect(
      stepCliProviderIds({ step: step(), taskCliProviderId: 'codex', enabledProviderIds: ENABLED }),
    ).toEqual(['codex']);
  });

  it('names nothing when there is no task provider either', () => {
    expect(
      stepCliProviderIds({ step: step(), taskCliProviderId: null, enabledProviderIds: ENABLED }),
    ).toEqual([]);
  });

  it('names every CLI a seat-configured fan-out will spend', () => {
    expect(
      stepCliProviderIds({
        step: step({
          preferredCliProviderId: 'codex',
          miningSeats: seats,
          miningSeatProviders: { 'security-code-reviewer': 'claude' },
        }),
        taskCliProviderId: 'gemini',
        enabledProviderIds: ENABLED,
      }),
    ).toEqual(['codex', 'claude']);
  });

  it('falls an unset seat through to the step default, not the task provider', () => {
    // Matches the picker's own "(step default)" option and resolvePreferredCli's order.
    expect(
      stepCliProviderIds({
        step: step({ preferredCliProviderId: 'codex', miningSeats: seats }),
        taskCliProviderId: 'gemini',
        enabledProviderIds: ENABLED,
      }),
    ).toEqual(['codex']);
  });

  it('falls a seat on a disabled provider back to the default, like the worker does', () => {
    expect(
      stepCliProviderIds({
        step: step({
          preferredCliProviderId: 'codex',
          miningSeats: seats,
          miningSeatProviders: { 'peer-reviewer': 'retired-row' },
        }),
        taskCliProviderId: 'gemini',
        enabledProviderIds: ENABLED,
      }),
    ).toEqual(['codex']);
  });

  it('ignores a step default on a disabled provider', () => {
    expect(
      stepCliProviderIds({
        step: step({ preferredCliProviderId: 'retired-row' }),
        taskCliProviderId: 'gemini',
        enabledProviderIds: ENABLED,
      }),
    ).toEqual(['gemini']);
  });

  it('keeps the step default even when every seat is set', () => {
    // It still runs the mining summary pass, and keeping it means this can only ever ADD a
    // meter to the header, never remove the one shown before per-seat selection existed.
    expect(
      stepCliProviderIds({
        step: step({
          preferredCliProviderId: 'gemini',
          miningSeats: seats,
          miningSeatProviders: { 'peer-reviewer': 'codex', 'security-code-reviewer': 'claude' },
        }),
        taskCliProviderId: null,
        enabledProviderIds: ENABLED,
      }),
    ).toEqual(['gemini', 'codex', 'claude']);
  });

  it('covers loop roles the same way as fan-out seats', () => {
    expect(
      stepCliProviderIds({
        step: step({
          cliRoles: [
            { id: 'validator', label: 'Validator' },
            { id: 'fixer', label: 'Fixer' },
          ],
          cliRoleProviders: { fixer: 'claude' },
        }),
        taskCliProviderId: 'codex',
        enabledProviderIds: ENABLED,
      }),
    ).toEqual(['codex', 'claude']);
  });

  it('dedupes seats that share one provider', () => {
    expect(
      stepCliProviderIds({
        step: step({
          preferredCliProviderId: 'codex',
          miningSeats: seats,
          miningSeatProviders: { 'peer-reviewer': 'claude', 'security-code-reviewer': 'claude' },
        }),
        taskCliProviderId: null,
        enabledProviderIds: ENABLED,
      }),
    ).toEqual(['codex', 'claude']);
  });

  it('names the task provider when no step row has loaded yet', () => {
    expect(
      stepCliProviderIds({ step: null, taskCliProviderId: 'codex', enabledProviderIds: ENABLED }),
    ).toEqual(['codex']);
  });
});
