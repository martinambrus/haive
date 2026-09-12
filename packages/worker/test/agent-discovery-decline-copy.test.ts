import { describe, it, expect } from 'vitest';
import { agentDiscoveryStep } from '../src/step-engine/steps/onboarding/06_5-agent-discovery.js';
import type { AgentDiscoveryDetect } from '../src/step-engine/steps/onboarding/06_5-agent-discovery.js';

// A declined agent normally renders "Not recommended: …" under an UNTICKED box. But four
// agents are pre-selected whatever the model says, because workflow steps call them by
// name — so for those the box stays TICKED, and the old copy put "Not recommended" under
// a checked checkbox. The sub-text has to agree with the tick, not with the flag.
const detect = (candidates: AgentDiscoveryDetect['candidates']): AgentDiscoveryDetect =>
  ({ candidates }) as AgentDiscoveryDetect;

const optionFor = (id: string, candidates: AgentDiscoveryDetect['candidates']) => {
  const schema = agentDiscoveryStep.form!({} as never, detect(candidates), undefined);
  const field = schema.fields[0] as {
    options: { value: string; description?: string }[];
    defaults?: string[];
  };
  return {
    opt: field.options.find((o) => o.value === id)!,
    ticked: (field.defaults ?? []).includes(id),
  };
};

const candidate = (id: string, declineReason?: string) => ({
  id,
  label: id,
  hint: 'h',
  count: 0,
  recommended: false,
  ...(declineReason ? { declineReason } : {}),
});

describe('06_5 decline copy', () => {
  it('says "Not recommended" for an agent that is actually unticked', () => {
    const { opt, ticked } = optionFor('api-route-dev', [
      candidate('api-route-dev', 'D7 has no route layer'),
    ]);
    expect(ticked).toBe(false);
    expect(opt.description).toBe('Not recommended: D7 has no route layer');
  });

  // code-reviewer is in ALWAYS_SELECTED, so it stays checked — the copy must explain the
  // override rather than contradict it.
  it('explains the override for an agent that stays ticked', () => {
    const { opt, ticked } = optionFor('code-reviewer', [
      candidate('code-reviewer', 'redundant with the four reviewers'),
    ]);
    expect(ticked).toBe(true);
    expect(opt.description).toMatch(/^Kept regardless/);
    expect(opt.description).not.toMatch(/^Not recommended/);
    expect(opt.description).toContain('redundant with the four reviewers');
  });

  it('adds no sub-text to an agent the model did not decline', () => {
    const { opt } = optionFor('peer-reviewer', [
      { ...candidate('peer-reviewer'), recommended: true },
    ]);
    expect(opt.description).toBeUndefined();
  });
});
