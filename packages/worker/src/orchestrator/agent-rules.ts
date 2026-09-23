import { CONFIG_KEYS, configService, normalizeContent, sha256Hex } from '@haive/shared';
import type { AgentRulesStamp } from '../cli-adapters/types.js';

export const AGENT_RULES_MARKER = '<haive_agent_rules>';
const AGENT_RULES_END = '</haive_agent_rules>';

const FRAMING =
  "Standing rules from this Haive install's CLI settings. The step's own instructions and output " +
  'contract take precedence where they differ; these supersede any differing `haive:cli-rules` ' +
  'block in AGENTS.md.';

/** The global switch. A failed read means OFF, the behaviour from before the switch existed, as
 *  for agent isolation. */
export async function resolveAgentRulesInjectionEnabled(): Promise<boolean> {
  try {
    return await configService.getBoolean(CONFIG_KEYS.AGENT_RULES_INJECTION_ENABLED, true);
  } catch {
    return false;
  }
}

export function agentRulesHash(rules: string): string {
  return sha256Hex(normalizeContent(rules));
}

/** Put `rules` at the top of the prompt, replacing a block that already opens it, which is how a
 *  stored prompt dispatched again gets today's rules instead of the ones it was stored with. Only a
 *  block at position 0 is Haive's: a marker anywhere else is text the prompt carries, such as a
 *  file or an earlier agent's reply, and must not be able to suppress or replace the injection.
 *  Null rules only strip, so a switched-off dispatch does not keep a stored block. */
export function withAgentRules(
  prompt: string,
  rules: string | null,
): { prompt: string; injected: boolean } {
  let body = prompt;
  if (body.startsWith(AGENT_RULES_MARKER)) {
    const end = body.indexOf(AGENT_RULES_END);
    if (end !== -1) body = body.slice(end + AGENT_RULES_END.length).replace(/^\n+/, '');
  }
  const text = rules?.trim().replaceAll(AGENT_RULES_END, '') ?? '';
  if (text.length === 0) return { prompt: body, injected: false };
  return {
    prompt: `${AGENT_RULES_MARKER}\n${FRAMING}\n\n${text}\n${AGENT_RULES_END}\n\n${body}`,
    injected: true,
  };
}

const SKIP_REASONS = new Set(['disabled', 'opt-out', 'prompt-too-large']);

/** The stamp a job payload's spec carries, or null for a spec without one: a sub-agent split, or a
 *  job enqueued before the field existed. */
export function agentRulesOf(spec: unknown): AgentRulesStamp | null {
  const raw = (spec as { agentRules?: unknown } | null)?.agentRules as
    { hash?: unknown; injected?: unknown; reason?: unknown } | null | undefined;
  if (!raw || typeof raw.injected !== 'boolean') return null;
  if (raw.hash !== null && typeof raw.hash !== 'string') return null;
  const stamp: AgentRulesStamp = { hash: raw.hash, injected: raw.injected };
  if (typeof raw.reason === 'string' && SKIP_REASONS.has(raw.reason)) {
    stamp.reason = raw.reason as AgentRulesStamp['reason'];
  }
  return stamp;
}
