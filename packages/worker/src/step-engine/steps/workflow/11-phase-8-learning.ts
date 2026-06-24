import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { FormSchema, InfoSection } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { RetryableParseError } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { loadTaskMeta } from './_task-meta.js';
import { parseJsonLoose } from '../_fenced-json.js';
import { clearTaskPromotedDrafts, promoteToGlobalKbDraft } from '../_global-kb-promote.js';

interface LearningDetect {
  taskTitle: string;
  taskDescription: string;
  feature: string | null;
  affectedClients: string[];
  implementSummary: string;
  filesTouched: string[];
  verifyPassed: boolean;
  commitSha: string | null;
  commitMessage: string;
  isBugFix: boolean;
}

interface LearningEntry {
  id: string;
  title: string;
  body: string;
}

interface Investigation {
  title: string;
  /** Observable symptoms + verbatim error strings — the lexical anchor that makes
   *  this investigation findable by future hybrid search. May be '' if omitted. */
  symptoms: string;
  rootCause: string;
  lesson: string;
  /** Routing decision (plan §5.4). `global` promotes the investigation to the
   *  cross-repo KB as a draft instead of writing it into this repo's
   *  knowledge_base/investigations/. Defaults to `local`. */
  scope?: 'local' | 'global';
}

interface LearningApply {
  entries: LearningEntry[];
  written: string[];
  investigationWritten: string | null;
  source: 'llm' | 'stub';
}

/** A bug-fix task is flagged at creation (tasks.metadata.category) or inferred
 *  from the title/description as a fallback. */
async function detectBugFix(
  ctx: StepContext,
  title: string,
  description: string,
): Promise<boolean> {
  const task = await ctx.db.query.tasks.findFirst({
    where: eq(schema.tasks.id, ctx.taskId),
    columns: { metadata: true },
  });
  const category = (task?.metadata as { category?: string } | null)?.category;
  if (category === 'bugfix') return true;
  return /\b(bug|fix|regression|hotfix|broken|crash)\b/i.test(`${title} ${description}`);
}

/** Parse the optional investigation block from the learning agent's output. */
export function parseInvestigation(raw: unknown): Investigation | null {
  let obj: Record<string, unknown> | null = null;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>;
  } else if (typeof raw === 'string') {
    const parsed = parseJsonLoose(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      obj = parsed as Record<string, unknown>;
    }
  }
  const inv = obj?.investigation;
  if (!inv || typeof inv !== 'object') return null;
  const i = inv as Record<string, unknown>;
  const title = typeof i.title === 'string' ? i.title : '';
  const symptoms = typeof i.symptoms === 'string' ? i.symptoms : '';
  const rootCause = typeof i.root_cause === 'string' ? i.root_cause : '';
  const lesson = typeof i.lesson === 'string' ? i.lesson : '';
  const scope: 'local' | 'global' = i.scope === 'global' ? 'global' : 'local';
  if (!title || !rootCause) return null;
  return { title, symptoms, rootCause, lesson, scope };
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
  const parsed = parseJsonLoose(text);
  if (Array.isArray(parsed)) return normaliseEntries(parsed);
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    Array.isArray((parsed as Record<string, unknown>).entries)
  ) {
    return normaliseEntries((parsed as Record<string, unknown>).entries as unknown[]);
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
  reviewerNote: string,
): Promise<string[]> {
  const dir = path.join(workspace, '.claude', 'learnings');
  await mkdir(dir, { recursive: true });
  const note = reviewerNote.trim() ? `\n\n## Reviewer note\n${reviewerNote.trim()}\n` : '';
  const written: string[] = [];
  for (const entry of entries) {
    const file = path.join(dir, `${entry.id}.md`);
    const body = `# ${entry.title}\n\n${entry.body}\n${note}`;
    await writeFile(file, body, 'utf8');
    written.push(path.relative(workspace, file));
  }
  return written;
}

/** Write a bug investigation into the knowledge base (auto-RAG-indexed by the
 *  next run's pre-rag-sync). `nowIso` is passed in — this is a normal worker
 *  step so the worker clock is fine. */
export async function writeInvestigation(
  workspace: string,
  inv: Investigation,
  taskTitle: string,
  reviewerNote: string,
  nowIso: string,
  feature: string | null,
  affectedClients: string[],
): Promise<string> {
  const dir = path.join(workspace, '.claude', 'knowledge_base', 'investigations');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${slugify(inv.title)}.md`);
  const note = reviewerNote.trim() ? `\n## Reviewer note\n${reviewerNote.trim()}\n` : '';
  const content = [
    '---',
    `title: ${inv.title}`,
    'type: bug-investigation',
    `date: ${nowIso}`,
    `task: ${taskTitle}`,
    ...(feature ? [`feature: ${JSON.stringify(feature)}`] : []),
    ...(affectedClients.length > 0 ? [`affected_clients: ${JSON.stringify(affectedClients)}`] : []),
    '---',
    '',
    `# ${inv.title}`,
    '',
    ...(inv.symptoms.trim() ? ['## Symptoms', inv.symptoms, ''] : []),
    '## Root cause',
    inv.rootCause,
    '',
    '## Lesson',
    inv.lesson || '(none recorded)',
    note,
  ].join('\n');
  await writeFile(file, content, 'utf8');
  return path.relative(workspace, file);
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
      isBugFix: await detectBugFix(ctx, meta.title, meta.description),
      feature: meta.feature,
      affectedClients: meta.affectedClients,
    };
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    timeoutMs: 60 * 60 * 1000,
    // Draft BEFORE the form so the user validates the agent's output (their
    // steer: human role = validation / comments, not authoring).
    preForm: true,
    buildPrompt: (args) => {
      const detected = args.detected as LearningDetect;
      return [
        'If a `.claude/agents/learning-recorder.md` agent definition exists in the repo, follow it;',
        'otherwise follow the protocol below.',
        'You are the learning capture phase of an engineering workflow.',
        'Emit ONE JSON object inside a ```json fenced code block with the shape:',
        detected.isBugFix
          ? '{ "entries": [ { "id": "<kebab-case>", "title": "<short>", "body": "<markdown>" } ], "investigation": { "title": "<short>", "symptoms": "<observable symptoms + the EXACT error strings/messages, verbatim>", "root_cause": "<why/how the bug happened>", "lesson": "<durable lesson for future runs>", "scope": "local | global" } }'
          : '{ "entries": [ { "id": "<kebab-case>", "title": "<short>", "body": "<markdown>" } ] }',
        'Each entry must be a reusable lesson grounded in the workflow run. Avoid generic advice.',
        detected.isBugFix
          ? 'This task was a BUG FIX: ALSO produce an `investigation`. In `symptoms`, lead with the observable symptoms and quote the EXACT error strings/messages verbatim — these are the lexical anchor future searches match on; name the affected feature/area. Give the root cause (why/how the bug existed, grounded in the implementation) and the durable lesson for future work. Set its `scope` to "global" ONLY when the lesson is a reusable house standard for any project of this stack (not specific to this repo); otherwise "local".'
          : '',
        '',
        `Task title: ${detected.taskTitle || '(untitled)'}`,
        `Task description: ${detected.taskDescription || '(none)'}`,
        `Feature/area: ${detected.feature ?? '(unspecified)'}`,
        `Implementation summary: ${detected.implementSummary || '(none)'}`,
        `Verification passed: ${detected.verifyPassed}`,
        `Commit sha: ${detected.commitSha ?? '(none)'}`,
        `Files touched: ${detected.filesTouched.join(', ') || '(none)'}`,
      ]
        .filter(Boolean)
        .join('\n');
    },
    bypassStub: (args) => {
      const d = args.detected as LearningDetect;
      const base = { entries: [{ id: 'bypass', title: 'Bypass stub', body: 'bypass' }] };
      return d.isBugFix
        ? {
            ...base,
            investigation: {
              title: 'Bypass',
              symptoms: 'stub',
              root_cause: 'stub',
              lesson: 'stub',
            },
          }
        : base;
    },
    retry: { maxAttempts: 3, retryOn: (e) => e instanceof RetryableParseError },
    // Form-aware: re-roll before the validation form when the draft produced no usable
    // learning entries, so the user validates a real draft rather than a stub.
    shouldRetryPreForm: (raw) => {
      const nonEmpty = typeof raw === 'string' ? raw.trim() !== '' : raw != null;
      if (!nonEmpty) return false;
      const parsed = parseLearningOutput(raw);
      return !parsed || parsed.length === 0;
    },
  },

  form(_ctx, detected, llmOutput): FormSchema {
    const entries = parseLearningOutput(llmOutput ?? null) ?? [];
    const investigation = detected.isBugFix ? parseInvestigation(llmOutput ?? null) : null;
    const infoSections: InfoSection[] = [];
    if (entries.length > 0) {
      infoSections.push({
        title: `Drafted learnings (${entries.length})`,
        preview: entries
          .map((e) => e.title)
          .join('; ')
          .slice(0, 80),
        body: entries.map((e) => `### ${e.title}\n\n${e.body}`).join('\n\n---\n\n'),
        defaultOpen: true,
      });
    }
    if (investigation) {
      infoSections.push({
        title: 'Drafted bug investigation',
        preview: investigation.title,
        body: `**${investigation.title}**\n\n${investigation.symptoms.trim() ? `## Symptoms\n${investigation.symptoms}\n\n` : ''}## Root cause\n${investigation.rootCause}\n\n## Lesson\n${investigation.lesson}`,
        defaultOpen: true,
      });
    }
    return {
      title: 'Phase 8: Learning capture',
      description: [
        `Task: ${detected.taskTitle || '(untitled)'}`,
        `Verification: ${detected.verifyPassed ? 'passed' : 'did not pass'}`,
        detected.isBugFix ? 'Bug fix — a knowledge-base investigation was drafted below.' : '',
        'Review the drafts below; approve to write them, add a note to refine, or untick to skip.',
      ]
        .filter(Boolean)
        .join('\n'),
      infoSections: infoSections.length > 0 ? infoSections : undefined,
      fields: [
        {
          type: 'checkbox',
          id: 'writeFiles',
          label: 'Write learning entries to .claude/learnings/',
          default: true,
        },
        ...(investigation
          ? [
              {
                type: 'checkbox' as const,
                id: 'writeInvestigation',
                label: 'Write the bug investigation to .claude/knowledge_base/investigations/',
                default: true,
              },
              {
                type: 'checkbox' as const,
                id: 'promoteInvestigationGlobal',
                label:
                  'Promote it to the GLOBAL KB (cross-repo house standard) instead of this repo',
                default: investigation.scope === 'global',
              },
            ]
          : []),
        {
          type: 'textarea',
          id: 'reviewerNote',
          label: 'Comments / refinements (optional, appended to what is written)',
          rows: 3,
        },
      ],
      submitLabel: 'Capture learnings',
    };
  },

  async apply(ctx, args): Promise<LearningApply> {
    const values = args.formValues as {
      writeFiles?: boolean;
      writeInvestigation?: boolean;
      promoteInvestigationGlobal?: boolean;
      reviewerNote?: string;
    };
    const reviewerNote = values.reviewerNote ?? '';
    // Write into the worktree (the feature branch), NOT the main checkout. ctx.repoPath
    // is the repo root; 01-worktree-setup created the worktree the rest of the pipeline
    // (07/10/11a/12) operates in, so KB/learnings must land there to be on the branch,
    // committed (11b-kb-commit), pushed (11a) and merged (12). Mirrors 10-gate-3-commit.
    const worktree = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
    const worktreePath =
      (worktree?.output as { worktreePath?: string } | null)?.worktreePath ?? ctx.workspacePath;
    const parsed = parseLearningOutput(args.llmOutput ?? null);
    const source: 'llm' | 'stub' = parsed && parsed.length > 0 ? 'llm' : 'stub';
    const entries = parsed && parsed.length > 0 ? parsed : stubLearning(args.detected);
    const written =
      values.writeFiles !== false
        ? await writeLearningEntries(worktreePath, entries, reviewerNote)
        : [];

    // Idempotent re-runs (Retry): replace this task's prior promoted drafts so a
    // retry never duplicates them (no-op when the global KB is off).
    await clearTaskPromotedDrafts(ctx.db, ctx.taskId, ctx.logger);
    let investigationWritten: string | null = null;
    const investigation = args.detected.isBugFix
      ? parseInvestigation(args.llmOutput ?? null)
      : null;
    if (investigation && values.writeInvestigation !== false) {
      if (investigation.scope === 'global' || values.promoteInvestigationGlobal) {
        // Promote as a draft to the cross-repo KB instead of writing it into this
        // repo's knowledge_base/investigations/ (which the local RAG indexes), so
        // the local store stays clean. Facets are left empty — the user scopes the
        // draft in Settings -> Global KB before activating it.
        const promo = await promoteToGlobalKbDraft(
          ctx.db,
          {
            userId: ctx.userId,
            taskId: ctx.taskId,
            title: investigation.title,
            body: `# ${investigation.title}\n\n${investigation.symptoms.trim() ? `## Symptoms\n${investigation.symptoms}\n\n` : ''}## Root cause\n${investigation.rootCause}\n\n## Lesson\n${investigation.lesson}`,
            category: 'anti_pattern',
            facets: {},
          },
          ctx.logger,
        );
        investigationWritten = promo ? `global-kb:${promo.id}` : null;
      } else {
        investigationWritten = await writeInvestigation(
          worktreePath,
          investigation,
          args.detected.taskTitle,
          reviewerNote,
          new Date().toISOString(),
          args.detected.feature,
          args.detected.affectedClients,
        );
      }
    }

    ctx.logger.info(
      { entries: entries.length, written: written.length, investigationWritten, source },
      'learning capture complete',
    );
    return { entries, written, investigationWritten, source };
  },
};
