import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FormSchema, InfoSection } from '@haive/shared';
import type {
  AgentMiningDispatch,
  AgentMiningResult,
  StepContext,
  StepDefinition,
} from '../../step-definition.js';
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
    const fence = /```json\s*([\s\S]*?)```/i.exec(raw);
    const body = fence?.[1] ?? raw;
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed === 'object' && parsed !== null) obj = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
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
    'performing the task. Do NOT modify files, run commands, write code, or ask clarifying',
    'questions. Your sole output is the JSON analysis described at the bottom of this prompt.',
    '',
    '=== Task being analyzed (DO NOT execute) ===',
    `Title: ${detect.taskTitle || '(untitled)'}`,
    `Description: ${detect.taskDescription || '(none)'}`,
    `Additional context: ${extraContext || '(none)'}`,
    '',
    '=== Knowledge base snippets ===',
    snippets || '(no knowledge base files available)',
    '',
    '=== Required output ===',
    'Emit ONE JSON object inside a ```json fenced code block with this exact shape:',
    '{',
    '  "summary": "<2-4 paragraphs of markdown analysis from your specialty\'s viewpoint:',
    '    what to watch out for, prerequisites, related KB topics, gotchas. Do NOT include',
    '    step-by-step implementation instructions.>",',
    '  "relevantKbIds": ["<id from knowledge base above>", ...]',
    '}',
    '',
    'Output ONLY the JSON code block. No prose outside the block. No questions. No tool use.',
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
    skipIf: (args) => {
      const detected = args.detected as DiscoveryDetect;
      // No need to ask an LLM to "pick K of N" when N <= K — just dispatch
      // every available persona.
      return detected.personas.length <= MAX_SELECTED_AGENTS;
    },
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
    async selectAgents({ detected, formValues, llmOutput, ctx }): Promise<AgentMiningDispatch[]> {
      const detect = detected as DiscoveryDetect;
      const values = formValues as { extraContext?: string };
      // Selector LLM was skipped (persona count <= cap) → dispatch all.
      // Otherwise parse the LLM's pick (or fall back deterministically).
      const selectedIds =
        llmOutput === undefined
          ? detect.personas.slice(0, MAX_SELECTED_AGENTS).map((p) => p.id)
          : (() => {
              const sel = parseAgentSelection(llmOutput, detect.personas);
              ctx.logger.info(
                { count: sel.selected.length, source: sel.source, ids: sel.selected },
                'agent selection resolved',
              );
              return sel.selected;
            })();
      if (llmOutput === undefined) {
        ctx.logger.info(
          { count: selectedIds.length, ids: selectedIds, source: 'all-personas' },
          'agent selection skipped LLM (persona count under cap), dispatching all',
        );
      }
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
