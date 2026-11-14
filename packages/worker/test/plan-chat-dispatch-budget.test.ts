import { describe, expect, it } from 'vitest';
import { resolveDispatch } from '../src/orchestrator/dispatcher.js';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';
import {
  PLAN_CHAT_TOTAL_MAX_CHARS,
  PLAN_CHAT_OUTPUT_RESERVE_CHARS,
} from '../src/step-engine/steps/plan/_plan-chat-context.js';

const provider = {
  id: 'cli',
  userId: 'owner',
  name: 'claude-code',
  enabled: true,
  authMode: 'subscription',
} as CliProviderRecord;
describe('plan chat dispatch budget', () => {
  it('accounts for fixed instructions, attachments, rules and output before optional context', () => {
    expect(PLAN_CHAT_TOTAL_MAX_CHARS).toBe(128_000);
    expect(PLAN_CHAT_OUTPUT_RESERVE_CHARS).toBe(32_000);
    const mandatory = 'PENDING WHOLE';
    const attachment = 'ATTACHMENT '.repeat(300);
    const rule = 'Standing rule '.repeat(100);
    const house = '<haive_house_rules>\nHouse standard stays whole.\n</haive_house_rules>';
    let available = 0;
    const plan = resolveDispatch({
      providers: [{ ...provider, rulesContent: rule }],
      invokeOpts: {},
      input: {
        kind: 'prompt',
        prompt: attachment + mandatory + 'x'.repeat(6000),
        capabilities: [],
      },
      agentRulesInjection: true,
      houseRules: { mode: 'write' },
      houseRuleSelection: { status: 'ok', entries: [], omitted: [], block: house },
      promptBudget: {
        maxChars: 12_000,
        outputReserveChars: 2_000,
        repack: (max) => {
          available = max;
          return (
            attachment +
            mandatory +
            'x'.repeat(Math.max(0, max - attachment.length - mandatory.length))
          );
        },
      },
    });
    expect(plan.effectivePrompt!.length + 2000).toBeLessThanOrEqual(12_000);
    expect(available).toBeLessThan(10_000);
    expect(plan.effectivePrompt).toContain(attachment);
    expect(plan.effectivePrompt).toContain(mandatory);
    expect(plan.effectivePrompt).toContain(rule.trim());
    expect(plan.effectivePrompt).toContain(house);
  });
});
