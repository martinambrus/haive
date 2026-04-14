import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { pathExists } from '../onboarding/_helpers.js';
import { loadTaskMeta } from './_task-meta.js';

interface KbSnippet {
  id: string;
  title: string;
  preview: string;
}

interface DiscoveryDetect {
  taskTitle: string;
  taskDescription: string;
  kbSnippets: KbSnippet[];
}

interface DiscoveryApply {
  summary: string;
  relevantKbIds: string[];
  source: 'llm' | 'stub';
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

export function parseDiscoverySummary(raw: unknown): {
  summary: string;
  relevantKbIds: string[];
} | null {
  if (!raw) return null;
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else if (typeof raw === 'object') {
    const asObj = raw as Record<string, unknown>;
    if (typeof asObj.summary === 'string') {
      return {
        summary: asObj.summary,
        relevantKbIds: Array.isArray(asObj.relevantKbIds)
          ? (asObj.relevantKbIds as unknown[]).filter((v): v is string => typeof v === 'string')
          : [],
      };
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
      typeof (parsed as Record<string, unknown>).summary === 'string'
    ) {
      const obj = parsed as Record<string, unknown>;
      return {
        summary: obj.summary as string,
        relevantKbIds: Array.isArray(obj.relevantKbIds)
          ? (obj.relevantKbIds as unknown[]).filter((v): v is string => typeof v === 'string')
          : [],
      };
    }
  } catch {
    return null;
  }
  return null;
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

export const phase0aDiscoveryStep: StepDefinition<DiscoveryDetect, DiscoveryApply> = {
  metadata: {
    id: '03-phase-0a-discovery',
    workflowType: 'workflow',
    index: 3,
    title: 'Phase 0a: Knowledge discovery',
    description:
      'Mines the project knowledge base for context relevant to the task and produces a condensed discovery summary for the pre-planning phase.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<DiscoveryDetect> {
    const meta = await loadTaskMeta(ctx.db, ctx.taskId);
    const kbSnippets = await collectKbSnippets(ctx.repoPath);
    return {
      taskTitle: meta.title,
      taskDescription: meta.description,
      kbSnippets,
    };
  },

  form(_ctx, detected): FormSchema {
    return {
      title: 'Phase 0a: Knowledge discovery',
      description: [
        `Task: ${detected.taskTitle || '(untitled)'}`,
        '',
        detected.taskDescription || '(no description)',
        '',
        `Knowledge base files discovered: ${detected.kbSnippets.length}`,
      ].join('\n'),
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
    optional: true,
    buildPrompt: (args) => {
      const detected = args.detected as DiscoveryDetect;
      const values = args.formValues as { extraContext?: string };
      const snippets = detected.kbSnippets.map((s) => `### ${s.id}\n${s.preview}`).join('\n\n');
      return [
        'You are the knowledge discovery phase of an engineering workflow.',
        'Produce a concise discovery summary grounded in the task description and the knowledge base snippets below.',
        'Emit ONE JSON object inside a ```json fenced code block with the shape:',
        '{ "summary": "<multi-paragraph markdown>", "relevantKbIds": ["id1","id2"] }',
        'Do not invent facts; only cite knowledge that appears in the snippets or task description.',
        '',
        `Task title: ${detected.taskTitle || '(untitled)'}`,
        `Task description: ${detected.taskDescription || '(none)'}`,
        `Additional context: ${values.extraContext ?? '(none)'}`,
        '',
        '=== Knowledge base snippets ===',
        snippets || '(no knowledge base files available)',
      ].join('\n');
    },
  },

  async apply(ctx, args): Promise<DiscoveryApply> {
    const parsed = parseDiscoverySummary(args.llmOutput ?? null);
    if (parsed) {
      ctx.logger.info(
        { relevantKbIds: parsed.relevantKbIds.length, source: 'llm' },
        'discovery summary parsed',
      );
      return {
        summary: parsed.summary,
        relevantKbIds: parsed.relevantKbIds,
        source: 'llm',
      };
    }
    const stub = stubDiscoverySummary(args.detected);
    ctx.logger.info(
      { relevantKbIds: stub.relevantKbIds.length, source: 'stub' },
      'discovery summary stubbed',
    );
    return {
      summary: stub.summary,
      relevantKbIds: stub.relevantKbIds,
      source: 'stub',
    };
  },
};
