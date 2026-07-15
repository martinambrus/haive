import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FormSchema, InfoSection } from '@haive/shared';
import type {
  AgentMiningDispatch,
  AgentMiningResult,
  StepContext,
  StepDefinition,
} from '../../step-definition.js';
import { isFatalProviderFailure } from '../../../queues/cli-exec/failure-class.js';
import { parseJsonLoose } from '../_fenced-json.js';
import { retrievalGuidanceLines } from '../_retrieval-guidance.js';
import { pathExists } from '../onboarding/_helpers.js';
import { loadTaskMeta } from './_task-meta.js';
import { loadAgentPersonas, type AgentPersona } from './_agent-loader.js';
import { buildAgentSelectorPrompt, parseAgentSelection } from './_agent-selector.js';

interface KbSnippet {
  id: string;
  title: string;
  preview: string;
}

interface DiscoveryDetect {
  taskTitle: string;
  taskDescription: string;
  feature: string | null;
  kbSnippets: KbSnippet[];
  personas: AgentPersona[];
}

interface AgentMiningSummary {
  agentId: string;
  agentTitle: string | null;
  status: 'done' | 'failed';
  summary: string;
  relevantKbIds: string[];
  errorMessage: string | null;
}

interface DiscoveryApply {
  summary: string;
  relevantKbIds: string[];
  source: 'agents' | 'stub';
  agentMinings: AgentMiningSummary[];
}

const MAX_SELECTED_AGENTS = 7;

// A miner is read-only enrichment, so a dropped provider connection is worth a
// bounded fresh run. Do not burn retries on known persistent provider failures,
// an intentional stop/timeout, or an unavailable provider — those need a user
// action rather than another identical terminal.
const TRANSIENT_MINING_TERMINAL_ERROR_RE =
  /\b(?:connection (?:closed|reset|aborted|dropped)|socket hang up|econn(?:reset|refused)|network (?:error|failure)|fetch failed|stream ended prematurely|unexpected end of (?:stream|response)|timed? out|timeout)\b/i;
const NON_RETRYABLE_MINING_TERMINAL_ERROR_RE =
  /\b(?:no cli provider available|cli process was stopped|task cancelled)\b/i;

function shouldRetryMiningTerminalFailure(result: AgentMiningResult): boolean {
  if (result.status !== 'failed') return false;
  const diagnostic = [result.errorMessage, result.rawOutput]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('\n');
  if (!diagnostic) return false;
  if (
    isFatalProviderFailure(diagnostic) ||
    NON_RETRYABLE_MINING_TERMINAL_ERROR_RE.test(diagnostic)
  ) {
    return false;
  }
  return TRANSIENT_MINING_TERMINAL_ERROR_RE.test(diagnostic);
}

function firstHeading(text: string): string | null {
  const m = /^#\s+(.+)$/m.exec(text);
  return m?.[1]?.trim() ?? null;
}

async function collectKbSnippets(repo: string): Promise<KbSnippet[]> {
  const dir = path.join(repo, '.claude', 'knowledge_base');
  if (!(await pathExists(dir))) return [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const out: KbSnippet[] = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      const id = e.name.replace(/\.md$/, '');
      const full = path.join(dir, e.name);
      try {
        const text = await readFile(full, 'utf8');
        out.push({
          id,
          title: firstHeading(text) ?? id,
          preview: text.trim().slice(0, 600),
        });
      } catch {
        continue;
      }
    }
    return out;
  } catch {
    return [];
  }
}

interface MiningJson {
  summary: string;
  relevantKbIds: string[];
}

function parseMiningOutput(raw: unknown): MiningJson | null {
  if (!raw) return null;
  let obj: Record<string, unknown> | null = null;
  if (typeof raw === 'string') {
    const parsed = parseJsonLoose(raw);
    if (parsed == null) return null;
    if (typeof parsed === 'object') obj = parsed as Record<string, unknown>;
  } else if (typeof raw === 'object') {
    obj = raw as Record<string, unknown>;
  }
  if (!obj) return null;
  if (typeof obj.summary !== 'string') return null;
  return {
    summary: obj.summary,
    relevantKbIds: Array.isArray(obj.relevantKbIds)
      ? (obj.relevantKbIds as unknown[]).filter((v): v is string => typeof v === 'string')
      : [],
  };
}

function stubDiscoverySummary(detect: DiscoveryDetect): {
  summary: string;
  relevantKbIds: string[];
} {
  const lines: string[] = [
    `Task: ${detect.taskTitle || '(untitled)'}`,
    '',
    detect.taskDescription || '(no description provided)',
    '',
    'Available knowledge base topics:',
  ];
  for (const snip of detect.kbSnippets) {
    lines.push(`- ${snip.id}: ${snip.title}`);
  }
  if (detect.kbSnippets.length === 0) {
    lines.push('- (none)');
  }
  return {
    summary: lines.join('\n'),
    relevantKbIds: detect.kbSnippets.map((s) => s.id),
  };
}

function buildAgentMiningPrompt(
  persona: AgentPersona,
  detect: DiscoveryDetect,
  extraContext: string,
): string {
  const snippets = detect.kbSnippets.map((s) => `### ${s.id}\n${s.preview}`).join('\n\n');
  const fieldLine = persona.field ? `Your field: ${persona.field}` : '';
  return [
    `You are providing READ-ONLY knowledge analysis as a "${persona.title}" specialist.`,
    '',
    `Your specialty: ${persona.description || '(general)'}`,
    fieldLine,
    '',
    'This is the knowledge-mining phase that runs BEFORE any implementation. You are NOT',
    'performing the task — your job is READ-ONLY research. Do NOT edit files, write code, run',
    'builds or tests, or any other mutating command, and do NOT ask clarifying questions.',
    '',
    '=== How to research — follow this order ===',
    ...retrievalGuidanceLines(),
    'Ground your analysis in what you actually retrieve, and stay strictly read-only throughout.',
    '',
    '=== Task being analyzed (DO NOT execute) ===',
    `Title: ${detect.taskTitle || '(untitled)'}`,
    `Description: ${detect.taskDescription || '(none)'}`,
    `Feature/area: ${detect.feature ?? '(unspecified)'}`,
    `Additional context: ${extraContext || '(none)'}`,
    '',
    '=== Knowledge base index (previews; use rag_search for full content) ===',
    snippets || '(no knowledge base files available)',
    '',
    '=== Required output ===',
    'When your research is done, emit ONE JSON object inside a ```json fenced code block with',
    'this exact shape:',
    '{',
    '  "summary": "<2-4 paragraphs of markdown analysis from your specialty\'s viewpoint:',
    '    what to watch out for, prerequisites, related KB topics, gotchas. Do NOT include',
    '    step-by-step implementation instructions.>",',
    '  "relevantKbIds": ["<id from the knowledge base index above>", ...]',
    '}',
    '',
    'The ```json code block must be the FINAL thing you output. No prose after it. No questions.',
  ].join('\n');
}

function aggregateMinings(results: AgentMiningResult[]): AgentMiningSummary[] {
  return results.map((r) => {
    if (r.status === 'failed') {
      return {
        agentId: r.agentId,
        agentTitle: r.agentTitle,
        status: 'failed' as const,
        summary: '',
        relevantKbIds: [],
        errorMessage: r.errorMessage,
      };
    }
    const parsed = parseMiningOutput(r.output ?? r.rawOutput);
    if (!parsed) {
      return {
        agentId: r.agentId,
        agentTitle: r.agentTitle,
        status: 'failed' as const,
        summary: '',
        relevantKbIds: [],
        errorMessage: 'agent returned no parseable mining JSON',
      };
    }
    return {
      agentId: r.agentId,
      agentTitle: r.agentTitle,
      status: 'done' as const,
      summary: parsed.summary,
      relevantKbIds: parsed.relevantKbIds,
      errorMessage: null,
    };
  });
}

function buildAggregatedSummary(minings: AgentMiningSummary[]): string {
  const sections: string[] = [];
  for (const m of minings) {
    if (m.status !== 'done') continue;
    const heading = m.agentTitle ?? m.agentId;
    sections.push(`## ${heading} (${m.agentId})\n\n${m.summary}`);
  }
  return sections.join('\n\n');
}

function unionKbIds(minings: AgentMiningSummary[]): string[] {
  const seen = new Set<string>();
  for (const m of minings) {
    for (const id of m.relevantKbIds) seen.add(id);
  }
  return [...seen];
}

export const phase0aDiscoveryStep: StepDefinition<DiscoveryDetect, DiscoveryApply> = {
  metadata: {
    id: '03-phase-0a-discovery',
    workflowType: 'workflow',
    index: 3,
    title: 'Phase 0a: Knowledge discovery',
    description:
      'Picks relevant agent personas and fans out per-agent knowledge mining over the project knowledge base, then aggregates a discovery summary for pre-planning.',
    requiresCli: false,
    // Under auto-continue, start mining on the defaults (no extra context) instead
    // of parking; manual mode still gates so the user can add context.
    autoSubmitDefaults: true,
  },

  async detect(ctx: StepContext): Promise<DiscoveryDetect> {
    const meta = await loadTaskMeta(ctx.db, ctx.taskId);
    const [kbSnippets, personas] = await Promise.all([
      collectKbSnippets(ctx.repoPath),
      loadAgentPersonas(ctx.repoPath),
    ]);
    return {
      taskTitle: meta.title,
      taskDescription: meta.description,
      feature: meta.feature,
      kbSnippets,
      personas,
    };
  },

  form(_ctx, detected): FormSchema {
    const infoSections: InfoSection[] = [];
    if (detected.kbSnippets.length > 0) {
      const lines = detected.kbSnippets.map((s) => `- ${s.id}: ${s.title}`);
      infoSections.push({
        title: 'Knowledge base files discovered',
        preview: `${detected.kbSnippets.length} file(s)`,
        body: lines.join('\n'),
      });
    }
    if (detected.personas.length > 0) {
      const lines = detected.personas.map((p) => {
        const fieldTag = p.field ? ` [${p.field}]` : '';
        return `- ${p.id}${fieldTag}: ${p.title}\n    ${p.description || '(no description)'}`;
      });
      infoSections.push({
        title: 'Agent personas available',
        preview: `${detected.personas.length} persona(s)`,
        body: lines.join('\n'),
      });
    }
    return {
      title: 'Phase 0a: Knowledge discovery',
      description: [
        `Task: ${detected.taskTitle || '(untitled)'}`,
        '',
        detected.taskDescription || '(no description)',
        '',
        'Expand the sections below to inspect what was found.',
      ].join('\n'),
      infoSections: infoSections.length > 0 ? infoSections : undefined,
      fields: [
        {
          type: 'textarea',
          id: 'extraContext',
          label: 'Additional context (optional)',
          rows: 4,
          placeholder: 'Paste relevant context the workflow should consider.',
        },
      ],
      submitLabel: 'Mine knowledge',
    };
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    timeoutMs: 60 * 60 * 1000,
    // Always run the selector — even when personas <= cap — so it filters by
    // RELEVANCE and picks a complexity-appropriate COUNT. Dispatching every
    // available persona (the old skipIf short-circuit) fanned out implementation/
    // review/test agents that have no business mining the KB for a given task.
    buildPrompt: (args) => {
      const detected = args.detected as DiscoveryDetect;
      const values = args.formValues as { extraContext?: string };
      return buildAgentSelectorPrompt({
        taskTitle: detected.taskTitle,
        taskDescription: detected.taskDescription,
        extraContext: values.extraContext,
        personas: detected.personas,
        maxAgents: MAX_SELECTED_AGENTS,
      });
    },
  },

  agentMining: {
    requiredCapabilities: ['tool_use'],
    timeoutMs: 60 * 60 * 1000,
    // Three total attempts (the initial terminal plus up to two fresh terminals)
    // for a dropped/closed provider connection. Each re-roll is scoped to the
    // failed persona; successful miners remain banked. Once this budget is spent,
    // apply() keeps the useful results or falls back to the deterministic stub.
    retry: {
      maxAttempts: 3,
      retryOnInvocationFailure: shouldRetryMiningTerminalFailure,
    },
    async selectAgents({ detected, formValues, llmOutput, ctx }): Promise<AgentMiningDispatch[]> {
      const detect = detected as DiscoveryDetect;
      const values = formValues as { extraContext?: string };
      // The selector LLM always runs now, so parse its relevance/complexity-based
      // pick. parseAgentSelection falls back to a small deterministic default if
      // the output is missing or unparseable — it never fans out to every persona.
      const sel = parseAgentSelection(llmOutput, detect.personas);
      ctx.logger.info(
        { count: sel.selected.length, source: sel.source, ids: sel.selected },
        'agent selection resolved',
      );
      const selectedIds = sel.selected;
      const byId = new Map(detect.personas.map((p) => [p.id, p]));
      const dispatches: AgentMiningDispatch[] = [];
      for (const id of selectedIds.slice(0, MAX_SELECTED_AGENTS)) {
        const persona = byId.get(id);
        if (!persona) continue;
        dispatches.push({
          agentId: persona.id,
          agentTitle: persona.title,
          prompt: buildAgentMiningPrompt(persona, detect, values.extraContext ?? ''),
        });
      }
      return dispatches;
    },
  },

  async apply(ctx, args): Promise<DiscoveryApply> {
    const minings = aggregateMinings(args.agentMiningResults ?? []);
    const successful = minings.filter((m) => m.status === 'done');
    if (successful.length > 0) {
      const summary = buildAggregatedSummary(minings);
      const relevantKbIds = unionKbIds(minings);
      ctx.logger.info(
        {
          successful: successful.length,
          failed: minings.length - successful.length,
          kbIds: relevantKbIds.length,
        },
        'discovery aggregated from agent minings',
      );
      return {
        summary,
        relevantKbIds,
        source: 'agents',
        agentMinings: minings,
      };
    }
    const stub = stubDiscoverySummary(args.detected);
    ctx.logger.warn(
      { miningCount: minings.length },
      'no successful agent minings, using stub summary',
    );
    return {
      summary: stub.summary,
      relevantKbIds: stub.relevantKbIds,
      source: 'stub',
      agentMinings: minings,
    };
  },
};
