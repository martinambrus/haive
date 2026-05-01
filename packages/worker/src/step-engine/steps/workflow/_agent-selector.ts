import type { AgentPersona } from './_agent-loader.js';

export interface AgentSelectorPromptArgs {
  taskTitle: string;
  taskDescription: string;
  extraContext?: string;
  personas: AgentPersona[];
  maxAgents: number;
}

export function buildAgentSelectorPrompt(args: AgentSelectorPromptArgs): string {
  const personaList = args.personas
    .map((p) => {
      const fieldTag = p.field ? ` [field: ${p.field}]` : '';
      return `- id: ${p.id}${fieldTag}\n  title: ${p.title}\n  description: ${p.description || '(none)'}`;
    })
    .join('\n');
  return [
    'You are the agent-selector phase of an engineering workflow.',
    `From the available agent personas below, pick UP TO ${args.maxAgents} agents whose expertise is most relevant to the task.`,
    'Prefer breadth (different fields) over depth (multiple agents on the same niche).',
    'Always include a knowledge-mining or research-style agent if one exists.',
    '',
    'Emit ONE JSON object inside a ```json fenced code block with the shape:',
    '{ "selected": ["agent-id-1", "agent-id-2", ...], "rationale": "<short markdown>" }',
    'Each selected id MUST match an available persona id verbatim. Do not invent ids.',
    '',
    `Task title: ${args.taskTitle || '(untitled)'}`,
    `Task description: ${args.taskDescription || '(none)'}`,
    `Additional context: ${args.extraContext || '(none)'}`,
    '',
    '=== Available agent personas ===',
    personaList || '(no personas available)',
  ].join('\n');
}

export interface AgentSelection {
  selected: string[];
  rationale: string;
  source: 'llm' | 'fallback';
}

export function parseAgentSelection(raw: unknown, personas: AgentPersona[]): AgentSelection {
  const validIds = new Set(personas.map((p) => p.id));
  const fromLlm = extractSelection(raw);
  if (fromLlm) {
    const selected = dedupeAndValidate(fromLlm.selected, validIds);
    if (selected.length > 0) {
      return { selected, rationale: fromLlm.rationale, source: 'llm' };
    }
  }
  return { selected: fallbackSelection(personas), rationale: '', source: 'fallback' };
}

function extractSelection(raw: unknown): { selected: string[]; rationale: string } | null {
  if (!raw) return null;
  let obj: Record<string, unknown> | null = null;
  if (typeof raw === 'string') {
    obj = parseJsonFromText(raw);
  } else if (typeof raw === 'object') {
    obj = raw as Record<string, unknown>;
  }
  if (!obj) return null;
  const sel = obj.selected;
  if (!Array.isArray(sel)) return null;
  const selected = sel.filter((v): v is string => typeof v === 'string');
  const rationale = typeof obj.rationale === 'string' ? obj.rationale : '';
  return { selected, rationale };
}

function parseJsonFromText(text: string): Record<string, unknown> | null {
  const fence = /```json\s*([\s\S]*?)```/i.exec(text);
  const body = fence?.[1] ?? text;
  try {
    const parsed = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function dedupeAndValidate(ids: string[], valid: Set<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed) || !valid.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

const FALLBACK_PRIORITY = ['knowledge-miner', 'code-reviewer', 'architect'];

function fallbackSelection(personas: AgentPersona[]): string[] {
  const byId = new Map(personas.map((p) => [p.id, p]));
  const out: string[] = [];
  for (const id of FALLBACK_PRIORITY) {
    if (byId.has(id)) out.push(id);
  }
  if (out.length === 0 && personas.length > 0) {
    out.push(...personas.slice(0, Math.min(3, personas.length)).map((p) => p.id));
  }
  return out;
}
