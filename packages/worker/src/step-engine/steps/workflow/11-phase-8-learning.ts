import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { loadTaskMeta } from './_task-meta.js';

interface LearningDetect {
  taskTitle: string;
  taskDescription: string;
  implementSummary: string;
  filesTouched: string[];
  verifyPassed: boolean;
  commitSha: string | null;
  commitMessage: string;
}

interface LearningEntry {
  id: string;
  title: string;
  body: string;
}

interface LearningApply {
  entries: LearningEntry[];
  written: string[];
  source: 'llm' | 'stub';
}

interface ImplementOutput {
  summary?: string;
  filesTouched?: string[];
  notes?: string;
}

interface VerifyOutput {
  passed?: boolean;
}

interface CommitOutput {
  committed?: boolean;
  commitSha?: string | null;
  message?: string;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export function parseLearningOutput(raw: unknown): LearningEntry[] | null {
  if (!raw) return null;
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else if (Array.isArray(raw)) {
    return normaliseEntries(raw);
  } else if (typeof raw === 'object') {
    const asObj = raw as Record<string, unknown>;
    if (Array.isArray(asObj.entries)) return normaliseEntries(asObj.entries);
    return null;
  } else {
    return null;
  }
  const fenceMatch = /```json\s*([\s\S]*?)```/.exec(text);
  const body = fenceMatch?.[1];
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) return normaliseEntries(parsed);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray((parsed as Record<string, unknown>).entries)
    ) {
      return normaliseEntries((parsed as Record<string, unknown>).entries as unknown[]);
    }
  } catch {
    return null;
  }
  return null;
}

function normaliseEntries(raw: unknown[]): LearningEntry[] {
  const out: LearningEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const title = typeof entry.title === 'string' ? entry.title : '';
    const body = typeof entry.body === 'string' ? entry.body : '';
    if (!title || !body) continue;
    const id = typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : slugify(title);
    out.push({ id, title, body });
  }
  return out;
}

function stubLearning(detect: LearningDetect): LearningEntry[] {
  const entry: LearningEntry = {
    id: slugify(detect.taskTitle || 'workflow-run'),
    title: `Workflow run: ${detect.taskTitle || '(untitled)'}`,
    body: [
      `Task: ${detect.taskTitle || '(untitled)'}`,
      '',
      detect.taskDescription || '(no description)',
      '',
      `Files touched: ${detect.filesTouched.length}`,
      detect.filesTouched.map((f) => `- ${f}`).join('\n') || '- (none)',
      '',
      `Verification: ${detect.verifyPassed ? 'passed' : 'did not pass'}`,
      detect.commitSha ? `Commit: ${detect.commitSha}` : 'No commit recorded.',
      '',
      'LLM synthesis skipped — stub learning entry written from deterministic context.',
    ].join('\n'),
  };
  return [entry];
}

async function writeLearningEntries(
  workspace: string,
  entries: LearningEntry[],
): Promise<string[]> {
  const dir = path.join(workspace, '.claude', 'learnings');
  await mkdir(dir, { recursive: true });
  const written: string[] = [];
  for (const entry of entries) {
    const file = path.join(dir, `${entry.id}.md`);
    const body = `# ${entry.title}\n\n${entry.body}\n`;
    await writeFile(file, body, 'utf8');
    written.push(path.relative(workspace, file));
  }
  return written;
}

export const phase8LearningStep: StepDefinition<LearningDetect, LearningApply> = {
  metadata: {
    id: '11-phase-8-learning',
    workflowType: 'workflow',
    index: 11,
    title: 'Phase 8: Learning capture',
    description:
      'Collects durable learnings from the completed workflow run and writes them to .claude/learnings/ for future reference.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<LearningDetect> {
    const meta = await loadTaskMeta(ctx.db, ctx.taskId);
    const implement = await loadPreviousStepOutput(ctx.db, ctx.taskId, '07-phase-2-implement');
    const verify = await loadPreviousStepOutput(ctx.db, ctx.taskId, '08-phase-5-verify');
    const commit = await loadPreviousStepOutput(ctx.db, ctx.taskId, '10-gate-3-commit');
    const implementOutput = (implement?.output as ImplementOutput | null) ?? {};
    const verifyOutput = (verify?.output as VerifyOutput | null) ?? {};
    const commitOutput = (commit?.output as CommitOutput | null) ?? {};
    return {
      taskTitle: meta.title,
      taskDescription: meta.description,
      implementSummary: implementOutput.summary ?? '',
      filesTouched: Array.isArray(implementOutput.filesTouched) ? implementOutput.filesTouched : [],
      verifyPassed: verifyOutput.passed === true,
      commitSha: commitOutput.commitSha ?? null,
      commitMessage: commitOutput.message ?? '',
    };
  },

  form(_ctx, detected): FormSchema {
    return {
      title: 'Phase 8: Learning capture',
      description: [
        `Task: ${detected.taskTitle || '(untitled)'}`,
        `Verification: ${detected.verifyPassed ? 'passed' : 'did not pass'}`,
        detected.commitSha ? `Commit: ${detected.commitSha}` : 'No commit recorded.',
        `Files touched: ${detected.filesTouched.length}`,
      ].join('\n'),
      fields: [
        {
          type: 'textarea',
          id: 'observations',
          label: 'Observations worth capturing (optional)',
          rows: 4,
          placeholder:
            'Patterns, surprises, follow-ups, or anything future runs should be aware of.',
        },
        {
          type: 'checkbox',
          id: 'writeFiles',
          label: 'Write learning entries to .claude/learnings/',
          default: true,
        },
      ],
      submitLabel: 'Capture learnings',
    };
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    timeoutMs: 60 * 60 * 1000,
    buildPrompt: (args) => {
      const detected = args.detected as LearningDetect;
      const values = args.formValues as { observations?: string };
      return [
        'You are the learning capture phase of an engineering workflow.',
        'Emit ONE JSON object inside a ```json fenced code block with the shape:',
        '{ "entries": [ { "id": "<kebab-case>", "title": "<short>", "body": "<markdown>" } ] }',
        'Each entry must be a reusable lesson grounded in the workflow run. Avoid generic advice.',
        '',
        `Task title: ${detected.taskTitle || '(untitled)'}`,
        `Task description: ${detected.taskDescription || '(none)'}`,
        `Implementation summary: ${detected.implementSummary || '(none)'}`,
        `Verification passed: ${detected.verifyPassed}`,
        `Commit sha: ${detected.commitSha ?? '(none)'}`,
        `Files touched: ${detected.filesTouched.join(', ') || '(none)'}`,
        `User observations: ${values.observations ?? '(none)'}`,
      ].join('\n');
    },
  },

  async apply(ctx, args): Promise<LearningApply> {
    const values = args.formValues as { writeFiles?: boolean };
    const parsed = parseLearningOutput(args.llmOutput ?? null);
    const source: 'llm' | 'stub' = parsed && parsed.length > 0 ? 'llm' : 'stub';
    const entries = parsed && parsed.length > 0 ? parsed : stubLearning(args.detected);
    const written =
      values.writeFiles !== false ? await writeLearningEntries(ctx.repoPath, entries) : [];
    ctx.logger.info(
      { entries: entries.length, written: written.length, source },
      'learning capture complete',
    );
    return { entries, written, source };
  },
};
