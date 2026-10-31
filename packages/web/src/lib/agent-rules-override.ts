import { DEFAULT_AGENT_RULES } from '@haive/shared/constants';
import { bodyToSave } from './body-edit';

export type RulesMode = 'default' | 'override';
export interface RulesState {
  mode: RulesMode;
  text: string;
}

/** null follows the default; a string, the empty one included, is an override. */
export function rulesStateFrom(stored: string | null): RulesState {
  return typeof stored === 'string'
    ? { mode: 'override', text: stored }
    : { mode: 'default', text: '' };
}

/** Override begins from the default text, never as an accidental empty override. In Default mode
 *  an empty `text` means no draft was written. */
export function startOverride(state: RulesState): RulesState {
  if (state.mode === 'override') return state;
  return { mode: 'override', text: state.text === '' ? DEFAULT_AGENT_RULES : state.text };
}

/** `editorBaseline` is the editor's own serialization of the loaded text. A draft kept while the
 *  mode is Default is not what a save would send, so it is not a change. */
export function isRulesDirty(
  loaded: RulesState,
  current: RulesState,
  editorBaseline: string | null,
): boolean {
  if (loaded.mode !== current.mode) return true;
  if (current.mode === 'default') return false;
  return bodyToSave(loaded.text, current.text, editorBaseline) !== undefined;
}

export interface AgentRulesApi {
  patch: (path: string, body: unknown) => Promise<{ agentRulesOverride?: string | null }>;
}

export type SaveAgentRulesResult =
  { ok: true; stored: string | null } | { ok: false; error: string };

/** PATCHes the rules alone and answers with the value the server kept: it normalises the text. */
export async function saveAgentRules(
  client: AgentRulesApi,
  repositoryId: string,
  state: RulesState,
): Promise<SaveAgentRulesResult> {
  try {
    const res = await client.patch(`/repositories/${repositoryId}/tooling`, {
      agentRulesOverride: state.mode === 'default' ? null : state.text,
    });
    return { ok: true, stored: res.agentRulesOverride ?? null };
  } catch (err) {
    return { ok: false, error: (err as Error).message || 'Failed to save the AGENTS.md rules' };
  }
}
