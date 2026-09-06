import { describe, expect, it } from 'vitest';
import {
  resolveCliChoiceValue,
  resolveSummaryChoiceValue,
  SUMMARY_CLI_OFF,
} from './last-cli-choice';

const PROVIDERS = ['p1', 'p2'];

describe('resolveCliChoiceValue', () => {
  it("falls back to the default for a repo with no recorded choice, rather than keeping the previous repo's", () => {
    expect(resolveCliChoiceValue(null, PROVIDERS)).toBe('');
  });

  it('restores a remembered provider', () => {
    expect(resolveCliChoiceValue({ providerId: 'p2' }, PROVIDERS)).toBe('p2');
  });

  it('restores an explicit "none" — the case a NULL fk alone could not express', () => {
    expect(resolveCliChoiceValue({ providerId: null }, PROVIDERS)).toBe('');
  });

  it('falls back to none when the remembered provider is gone', () => {
    expect(resolveCliChoiceValue({ providerId: 'deleted' }, PROVIDERS)).toBe('');
  });
});

describe('resolveSummaryChoiceValue', () => {
  it('falls back to inherit for a repo with no recorded choice', () => {
    expect(resolveSummaryChoiceValue(null, PROVIDERS)).toBe('');
  });

  it('restores a remembered summary provider', () => {
    expect(resolveSummaryChoiceValue({ providerId: 'p1', llmEnabled: true }, PROVIDERS)).toBe('p1');
  });

  it('restores an explicit inherit', () => {
    expect(resolveSummaryChoiceValue({ providerId: null, llmEnabled: true }, PROVIDERS)).toBe('');
  });

  it('restores off', () => {
    expect(resolveSummaryChoiceValue({ providerId: null, llmEnabled: false }, PROVIDERS)).toBe(
      SUMMARY_CLI_OFF,
    );
  });

  it('lets off win over a provider that is also recorded', () => {
    expect(resolveSummaryChoiceValue({ providerId: 'p1', llmEnabled: false }, PROVIDERS)).toBe(
      SUMMARY_CLI_OFF,
    );
  });

  it('falls back to inherit when the remembered provider is gone', () => {
    expect(resolveSummaryChoiceValue({ providerId: 'deleted', llmEnabled: true }, PROVIDERS)).toBe(
      '',
    );
  });
});
