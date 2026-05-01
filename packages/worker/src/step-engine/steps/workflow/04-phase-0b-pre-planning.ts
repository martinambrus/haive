import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FormSchema, InfoSection } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput, pathExists } from '../onboarding/_helpers.js';
import { loadTaskMeta } from './_task-meta.js';

interface KbReference {
  id: string;
  title: string;
  exists: boolean;
}

interface PrePlanningDetect {
  taskTitle: string;
  taskDescription: string;
  discoverySummary: string;
  relevantKbIds: string[];
  kbReferences: KbReference[];
}

function kbHeading(text: string): string | null {
  const m = /^#\s+(.+)$/m.exec(text);
  return m?.[1]?.trim() ?? null;
}

async function resolveKbReferences(repoPath: string, ids: string[]): Promise<KbReference[]> {
  const dir = path.join(repoPath, '.claude', 'knowledge_base');
  const out: KbReference[] = [];
  for (const id of ids) {
    const full = path.join(dir, `${id}.md`);
    if (!(await pathExists(full))) {
      out.push({ id, title: id, exists: false });
      continue;
    }
    try {
      const text = await readFile(full, 'utf8');
      out.push({ id, title: kbHeading(text) ?? id, exists: true });
    } catch {
      out.push({ id, title: id, exists: false });
    }
  }
  return out;
}

interface PrePlanningApply {
  summary: string;
  spec: string;
  source: 'llm' | 'stub';
}

interface DiscoveryOutput {
  summary?: string;
  relevantKbIds?: string[];
}

export function parsePrePlanningOutput(raw: unknown): {
  summary: string;
  spec: string;
} | null {
  if (!raw) return null;
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else if (typeof raw === 'object') {
    const asObj = raw as Record<string, unknown>;
    if (typeof asObj.summary === 'string' && typeof asObj.spec === 'string') {
      return { summary: asObj.summary, spec: asObj.spec };
    }
    return null;
  } else {
    return null;
  }
  const fenceMatch = /```json\s*([\s\S]*?)```/.exec(text);
  const body = fenceMatch?.[1];
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).summary === 'string' &&
      typeof (parsed as Record<string, unknown>).spec === 'string'
    ) {
      const obj = parsed as Record<string, unknown>;
      return { summary: obj.summary as string, spec: obj.spec as string };
    }
  } catch {
    return null;
  }
  return null;
}

function stubPrePlanning(detect: PrePlanningDetect): { summary: string; spec: string } {
  const title = detect.taskTitle || '(untitled task)';
  const description = detect.taskDescription || '(no description provided)';
  const summary = [
    `Pre-planning draft for: ${title}`,
    '',
    description,
    '',
    detect.discoverySummary ? 'Discovery context incorporated.' : 'Discovery context unavailable.',
  ].join('\n');
  const specLines = [
    `# Spec: ${title}`,
    '',
    '## Goal',
    description,
    '',
    '## Discovery context',
    detect.discoverySummary || '(none)',
    '',
    '## Relevant knowledge base',
    detect.relevantKbIds.length > 0
      ? detect.relevantKbIds.map((id) => `- ${id}`).join('\n')
      : '- (none)',
    '',
    '## Approach',
    '- (to be filled in during implementation phase)',
    '',
    '## Risks',
    '- (none identified)',
    '',
    '## Acceptance criteria',
    '- (to be filled in before gate 1)',
  ];
  return { summary, spec: specLines.join('\n') };
}

export const phase0bPrePlanningStep: StepDefinition<PrePlanningDetect, PrePlanningApply> = {
  metadata: {
    id: '04-phase-0b-pre-planning',
    workflowType: 'workflow',
    index: 4,
    title: 'Phase 0b: Pre-planning',
    description:
      'Produces a draft specification for the task using the discovery summary as context.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<PrePlanningDetect> {
    const meta = await loadTaskMeta(ctx.db, ctx.taskId);
    const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '03-phase-0a-discovery');
    const output = (prev?.output as DiscoveryOutput | null) ?? {};
    const ids = Array.isArray(output.relevantKbIds) ? output.relevantKbIds : [];
    const kbReferences = await resolveKbReferences(ctx.repoPath, ids);
    return {
      taskTitle: meta.title,
      taskDescription: meta.description,
      discoverySummary: output.summary ?? '',
      relevantKbIds: ids,
      kbReferences,
    };
  },

  form(_ctx, detected): FormSchema {
    const infoSections: InfoSection[] = [];
    if (detected.discoverySummary) {
      infoSections.push({
        title: 'Discovery summary',
        preview: `${detected.discoverySummary.length} chars`,
        body: detected.discoverySummary,
      });
    }
    if (detected.kbReferences.length > 0) {
      const lines = detected.kbReferences.map((kb) =>
        kb.exists ? `- ${kb.id}: ${kb.title}` : `- ${kb.id}: (file not found in repo)`,
      );
      infoSections.push({
        title: 'Relevant knowledge base files',
        preview: `${detected.kbReferences.length} file(s)`,
        body: lines.join('\n'),
      });
    }
    return {
      title: 'Phase 0b: Pre-planning',
      description: [
        `Task: ${detected.taskTitle || '(untitled)'}`,
        '',
        detected.taskDescription || '(no description)',
        '',
        detected.discoverySummary
          ? 'Discovery summary and KB files available below — expand to inspect.'
          : 'Discovery summary not available.',
      ].join('\n'),
      infoSections: infoSections.length > 0 ? infoSections : undefined,
      fields: [
        {
          type: 'textarea',
          id: 'scope',
          label: 'Scope / constraints (optional)',
          rows: 4,
          placeholder: 'Explicit boundaries, out-of-scope items, hard constraints.',
        },
      ],
      submitLabel: 'Draft spec',
    };
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    timeoutMs: 60 * 60 * 1000,
    buildPrompt: (args) => {
      const detected = args.detected as PrePlanningDetect;
      const values = args.formValues as { scope?: string };
      return [
        'You are the pre-planning phase of an engineering workflow.',
        'Produce a concise draft specification for the task below.',
        'Emit ONE JSON object inside a ```json fenced code block with the shape:',
        '{ "summary": "<short rationale>", "spec": "<markdown spec body>" }',
        'The spec body must include sections: Goal, Approach, Risks, Acceptance criteria.',
        'Ground every claim in the discovery summary — do not invent details.',
        '',
        `Task title: ${detected.taskTitle || '(untitled)'}`,
        `Task description: ${detected.taskDescription || '(none)'}`,
        `Scope guidance: ${values.scope ?? '(none)'}`,
        '',
        '=== Discovery summary ===',
        detected.discoverySummary || '(none)',
        '',
        `Relevant KB ids: ${detected.relevantKbIds.join(', ') || '(none)'}`,
      ].join('\n');
    },
  },

  async apply(ctx, args): Promise<PrePlanningApply> {
    const parsed = parsePrePlanningOutput(args.llmOutput ?? null);
    if (parsed) {
      ctx.logger.info({ source: 'llm' }, 'pre-planning spec parsed');
      return { summary: parsed.summary, spec: parsed.spec, source: 'llm' };
    }
    const stub = stubPrePlanning(args.detected);
    ctx.logger.info({ source: 'stub' }, 'pre-planning spec stubbed');
    return { summary: stub.summary, spec: stub.spec, source: 'stub' };
  },
};
