import { describe, expect, it } from 'vitest';
import { stepCliProviderIds, type StepCliProviderSource } from './step-cli-providers';

const LISTED = new Set(['codex', 'claude', 'gemini']);

const step = (over: Partial<StepCliProviderSource> = {}): StepCliProviderSource => ({
  preferredCliProviderId: null,
  ...over,
});

const seats = [
  { id: 'peer-reviewer', label: 'Peer Reviewer' },
  { id: 'security-code-reviewer', label: 'Security Code Reviewer' },
];

describe('stepCliProviderIds', () => {
  it('names no provider for an unavailable round choice instead of the task fallback', () => {
    expect(
      stepCliProviderIds({
        step: { preferredCliProviderId: null, roundCliUnavailable: true } as StepCliProviderSource,
        taskCliProviderId: 'codex',
        listedProviderIds: LISTED,
      }),
    ).toEqual([]);
  });

  it('names just the task provider for a step with nothing configured', () => {
    expect(
      stepCliProviderIds({ step: step(), taskCliProviderId: 'codex', listedProviderIds: LISTED }),
    ).toEqual(['codex']);
  });

  it('names nothing when there is no task provider either', () => {
    expect(
      stepCliProviderIds({ step: step(), taskCliProviderId: null, listedProviderIds: LISTED }),
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
        listedProviderIds: LISTED,
      }),
    ).toEqual(['codex', 'claude']);
  });

  it('falls an unset seat through to the step default, not the task provider', () => {
    // Matches the picker's seat fallback to the step's CLI and resolvePreferredCli's order.
    expect(
      stepCliProviderIds({
        step: step({ preferredCliProviderId: 'codex', miningSeats: seats }),
        taskCliProviderId: 'gemini',
        listedProviderIds: LISTED,
      }),
    ).toEqual(['codex']);
  });

  it('falls a seat on a deleted provider back to the default, like the worker does', () => {
    expect(
      stepCliProviderIds({
        step: step({
          preferredCliProviderId: 'codex',
          miningSeats: seats,
          miningSeatProviders: { 'peer-reviewer': 'retired-row' },
        }),
        taskCliProviderId: 'gemini',
        listedProviderIds: LISTED,
      }),
    ).toEqual(['codex']);
  });

  it('ignores a step default on a deleted provider', () => {
    expect(
      stepCliProviderIds({
        step: step({ preferredCliProviderId: 'retired-row' }),
        taskCliProviderId: 'gemini',
        listedProviderIds: LISTED,
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
        listedProviderIds: LISTED,
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
        listedProviderIds: LISTED,
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
        listedProviderIds: LISTED,
      }),
    ).toEqual(['codex', 'claude']);
  });

  it('names the task provider when no step row has loaded yet', () => {
    expect(
      stepCliProviderIds({ step: null, taskCliProviderId: 'codex', listedProviderIds: LISTED }),
    ).toEqual(['codex']);
  });

  it('counts every provider row passed, so a pick on a switched-off provider is kept', () => {
    const everyRow = new Set([...LISTED, 'switched-off']);
    expect(
      stepCliProviderIds({
        step: step({
          preferredCliProviderId: 'switched-off',
          miningSeats: seats,
          miningSeatProviders: {
            'peer-reviewer': 'switched-off',
            'security-code-reviewer': 'claude',
          },
        }),
        taskCliProviderId: 'gemini',
        listedProviderIds: everyRow,
      }),
    ).toEqual(['switched-off', 'claude']);
  });
});
