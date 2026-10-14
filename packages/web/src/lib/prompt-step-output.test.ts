import { describe, expect, it } from 'vitest';
import { promptStepReply } from './prompt-step-output';

describe('promptStepReply', () => {
  it('returns the raw reply of a done prompt step', () => {
    expect(promptStepReply('custom.t.a', 'done', { raw: '## Hi', parsed: null })).toBe('## Hi');
  });

  it('is null for a built-in step, whatever its output holds', () => {
    expect(promptStepReply('04-phase-0b-pre-planning', 'done', { raw: 'x' })).toBeNull();
    expect(promptStepReply('module.m.s', 'done', { raw: 'x' })).toBeNull();
  });

  it('is null until the step is done and for an empty or malformed output', () => {
    expect(promptStepReply('custom.t.a', 'running', { raw: 'x' })).toBeNull();
    expect(promptStepReply('custom.t.a', 'done', { raw: '  ' })).toBeNull();
    expect(promptStepReply('custom.t.a', 'done', { raw: 4 })).toBeNull();
    expect(promptStepReply('custom.t.a', 'done', null)).toBeNull();
  });
});
