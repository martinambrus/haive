import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_RULES } from '@haive/shared/constants';
import {
  isRulesDirty,
  rulesStateFrom,
  saveAgentRules,
  startOverride,
  type RulesState,
} from './agent-rules-override';

const PATH = '/repositories/repo-1/tooling';
const follows: RulesState = { mode: 'default', text: '' };
const override = (text: string): RulesState => ({ mode: 'override', text });

describe('rulesStateFrom', () => {
  it('reads null as following the default', () => {
    expect(rulesStateFrom(null)).toEqual(follows);
  });

  it('reads a string as an override and keeps its text verbatim', () => {
    expect(rulesStateFrom('# Rules\n\n- one\n')).toEqual(override('# Rules\n\n- one\n'));
  });

  it('keeps an explicit empty override apart from null', () => {
    expect(rulesStateFrom('')).toEqual(override(''));
    expect(rulesStateFrom('')).not.toEqual(rulesStateFrom(null));
  });
});

describe('startOverride', () => {
  it('pre-fills the default text when the draft was never edited', () => {
    expect(startOverride(follows)).toEqual(override(DEFAULT_AGENT_RULES));
  });

  it('keeps a draft the person already wrote', () => {
    expect(startOverride({ mode: 'default', text: 'My draft' })).toEqual(override('My draft'));
  });

  it('leaves an override alone, an explicit empty one included', () => {
    expect(startOverride(override(''))).toEqual(override(''));
    expect(startOverride(override('Mine'))).toEqual(override('Mine'));
  });
});

describe('isRulesDirty', () => {
  const loaded = 'Use ```fenced``` examples.';
  const normalized = 'Use `fenced` examples.';

  it('is clean for the loaded state, whatever the mode', () => {
    expect(isRulesDirty(follows, follows, null)).toBe(false);
    expect(isRulesDirty(override(loaded), override(loaded), null)).toBe(false);
    expect(isRulesDirty(override(''), override(''), null)).toBe(false);
  });

  it('is dirty when the mode differs, in both directions', () => {
    expect(isRulesDirty(follows, override(DEFAULT_AGENT_RULES), null)).toBe(true);
    expect(isRulesDirty(override(loaded), follows, null)).toBe(true);
  });

  it('tells an explicit empty override from following the default', () => {
    expect(isRulesDirty(follows, override(''), null)).toBe(true);
    expect(isRulesDirty(override(''), { mode: 'default', text: '' }, null)).toBe(true);
  });

  it('ignores a draft kept while the mode is Default', () => {
    expect(isRulesDirty(follows, { mode: 'default', text: 'Left over' }, null)).toBe(false);
  });

  it('is dirty when the override text changed', () => {
    expect(isRulesDirty(override(loaded), override(`${loaded} More.`), null)).toBe(true);
    expect(isRulesDirty(override(loaded), override(''), null)).toBe(true);
  });

  it('is clean when the editor only re-serialized the loaded text', () => {
    expect(isRulesDirty(override(loaded), override(normalized), normalized)).toBe(false);
  });

  it('is dirty when the text differs from both the loaded text and the editor baseline', () => {
    expect(isRulesDirty(override(loaded), override(`${normalized} More.`), normalized)).toBe(true);
  });

  it('is dirty when the text differs and the editor has reported no baseline yet', () => {
    expect(isRulesDirty(override(loaded), override(normalized), null)).toBe(true);
  });
});

describe('saveAgentRules', () => {
  const client = (response: unknown) => ({ patch: vi.fn().mockResolvedValue(response) });

  it('sends null alone in Default mode, whatever draft is kept', async () => {
    const api = client({ agentRulesOverride: null });
    const out = await saveAgentRules(api, 'repo-1', { mode: 'default', text: 'Left over' });
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(api.patch.mock.calls[0]![0]).toBe(PATH);
    expect(api.patch.mock.calls[0]![1]).toStrictEqual({ agentRulesOverride: null });
    expect(out).toEqual({ ok: true, stored: null });
  });

  it('sends the text alone in Override mode', async () => {
    const api = client({ agentRulesOverride: '# Mine\n' });
    await saveAgentRules(api, 'repo-1', override('# Mine\n'));
    expect(api.patch.mock.calls[0]![1]).toStrictEqual({ agentRulesOverride: '# Mine\n' });
  });

  it('sends an explicit empty override as the empty string, not null', async () => {
    const api = client({ agentRulesOverride: '' });
    const out = await saveAgentRules(api, 'repo-1', override(''));
    expect(api.patch.mock.calls[0]![1]).toStrictEqual({ agentRulesOverride: '' });
    expect(out).toEqual({ ok: true, stored: '' });
  });

  it('answers with the value the server stored, not the text it was sent', async () => {
    const api = client({ agentRulesOverride: 'Raw text\n' });
    const out = await saveAgentRules(api, 'repo-1', override('Raw text  \r\n\r\n'));
    expect(out).toEqual({ ok: true, stored: 'Raw text\n' });
  });

  it('answers with null when the server stored none, whatever it was sent', async () => {
    const api = client({ agentRulesOverride: null });
    expect(await saveAgentRules(api, 'repo-1', override('Sent text'))).toEqual({
      ok: true,
      stored: null,
    });
  });

  it('keeps a stored empty string apart from null', async () => {
    const api = client({ agentRulesOverride: '' });
    expect(await saveAgentRules(api, 'repo-1', override('   '))).toEqual({ ok: true, stored: '' });
  });

  it('returns the server message when the request fails', async () => {
    const api = {
      patch: vi.fn().mockRejectedValue(new Error('Invalid AGENTS.md rules: holds a NUL character')),
    };
    expect(await saveAgentRules(api, 'repo-1', override('x'))).toEqual({
      ok: false,
      error: 'Invalid AGENTS.md rules: holds a NUL character',
    });
  });

  it('falls back to a plain message when the failure carries none', async () => {
    const api = { patch: vi.fn().mockRejectedValue(new Error('')) };
    expect(await saveAgentRules(api, 'repo-1', follows)).toEqual({
      ok: false,
      error: 'Failed to save the AGENTS.md rules',
    });
  });
});
