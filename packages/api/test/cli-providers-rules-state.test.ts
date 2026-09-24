import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_RULES } from '@haive/shared';
import { withRulesState } from '../src/routes/cli-providers.js';

describe('withRulesState', () => {
  it('marks a provider holding no rules or a copy of a shipped default as inheriting', () => {
    expect(withRulesState({ rulesContent: '' }).rulesInherited).toBe(true);
    expect(withRulesState({ rulesContent: DEFAULT_AGENT_RULES }).rulesInherited).toBe(true);
  });

  it('marks edited rules as an override and keeps the row otherwise intact', () => {
    const row = withRulesState({ id: 'p1', rulesContent: '- my rule' });
    expect(row).toEqual({ id: 'p1', rulesContent: '- my rule', rulesInherited: false });
  });
});
