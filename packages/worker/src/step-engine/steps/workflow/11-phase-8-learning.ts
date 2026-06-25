import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { FormSchema, InfoSection } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { RetryableParseError } from '../../step-definition.js';
import { loadPreviousStepOutput, pathExists } from '../onboarding/_helpers.js';
import { loadTaskMeta } from './_task-meta.js';
import { parseJsonLoose } from '../_fenced-json.js';
import {
  clearTaskPromotedDrafts,
  globalKbTopicKey,
  loadActiveGlobalArticlesForStack,
  promoteToGlobalKbDraft,
} from '../_global-kb-promote.js';
import { loadRepoStackAnchors, techAnchorFacets } from '../_repo-stack.js';
import { buildTaskHistoryDigest, type TaskHistoryDigest } from './_task-history-digest.js';
import { KNOWLEDGE_DIFF_ARTIFACT_NAME, buildKnowledgeDiffArtifact } from './_knowledge-diff.js';
import type { CommitDiffFile } from './_commit-diff.js';

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
  /** Curated, bounded, complexity-tiered digest of what actually happened during
   *  the run (per-round diagnoses, findings, human gate reactions, runtime errors),
   *  mined from the persisted history so the agent grounds output in the real run. */
  historyDigest: TaskHistoryDigest;
  /** The per-task worktree (feature branch) the pipeline operates in — loaded from
   *  01-worktree-setup, where KB/learnings are written. */
  worktreePath: string;
  /** Bounded summary of the existing .claude/learnings/ entries (id + title +
   *  excerpt) so the agent can reconcile (dedup / update / delete) against them. */
  existingLearnings: { id: string; title: string; excerpt: string }[];
  /** Repo's installed-stack anchors (from its onboarding) for version-anchoring a
   *  promoted global article; null when the repo never completed onboarding. */
  repoStack: Awaited<ReturnType<typeof loadRepoStackAnchors>>;
  /** Existing active global house-standard articles matching this repo's stack —
   *  shown to the agent so it can author an UPDATE (full merged body) vs a new one. */
  existingGlobalArticles: { title: string; body: string }[];
  /** Stable `.haive/` path the form's knowledge-diff viewer fetches; the file is
   *  written by prepareForm post-llm. null when the worktree has no git repo. */
  knowledgeDiffArtifactPath: string | null;
}

interface LearningEntry {
  id: string;
  title: string;
  body: string;
  /** Reconciliation op against the existing .claude/learnings/ set. Defaults to
   *  'insert'. 'update'/'delete' require targetId to name an existing entry. */
  op: 'insert' | 'update' | 'delete';
  /** For update/delete: the existing learning id (filename slug) to act on. */
  targetId?: string;
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

/** One structured-KB file the learning agent edited to keep the knowledge base in
 *  sync with what this task built/changed/removed (Feature KB Sync). */
interface KbSyncChange {
  file: string;
  op: 'insert' | 'update' | 'delete';
  summary: string;
}

interface KbSync {
  classification: string;
  changes: KbSyncChange[];
}

interface LearningApply {
  entries: LearningEntry[];
  written: string[];
  /** Learning files removed by a reconciled `delete` op (relative paths). */
  deleted: string[];
  investigationWritten: string | null;
  /** Feature KB Sync result: the classification + the structured-KB files the agent
   *  edited in the worktree. null when the agent reported none. */
  kbSync: KbSync | null;
  /** True when the user unticked "keep KB sync" and apply reverted the agent's
   *  knowledge_base edits before commit. */
  kbReverted: boolean;
  /** `global-kb:<id>` refs for the house-standard candidates the user promoted. */
  promotedCandidates: string[];
  source: 'llm' | 'stub';
}

/** A portable house-standard article the learning agent proposes for the cross-repo
 *  global KB (distinct from a bug investigation, which stays standalone). When its
 *  computed topicKey matches an existing article, the promotion links + supersedes
 *  it; the agent authors `body` as the full merged article for that case. */
interface GlobalCandidate {
  id: string;
  title: string;
  body: string;
  category: 'tech_pattern' | 'best_practice' | 'anti_pattern' | 'quick_reference' | 'general';
  /** Public tech slug the article is about — drives deterministic version anchoring. */
  tech: string;
}

const GLOBAL_CANDIDATE_CATEGORIES = new Set([
  'tech_pattern',
  'best_practice',
  'anti_pattern',
  'quick_reference',
  'general',
]);

const execFileP = promisify(execFile);

/** Runs git in `cwd`, returning stdout/stderr/exit code (never throws) — the
 *  GitRun contract the shared knowledge/commit diff builder expects. */
async function gitRun(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileP('git', args, { cwd });
    return { stdout: stdout.toString(), stderr: stderr.toString(), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: (e.stdout ?? '').toString(),
      stderr: (e.stderr ?? '').toString(),
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

/** Valid op values for a reported KB sync change. */
const KB_SYNC_OPS = new Set(['insert', 'update', 'delete']);

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

/** Parse the optional Feature KB Sync block the learning agent reports after editing
 *  the structured KB files. Defensive: unknown ops and non-string fields are dropped. */
export function parseKbSync(raw: unknown): KbSync | null {
  let obj: Record<string, unknown> | null = null;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>;
  } else if (typeof raw === 'string') {
    const parsed = parseJsonLoose(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      obj = parsed as Record<string, unknown>;
    }
  }
  const ks = obj?.kbSync ?? obj?.kb_sync;
  if (!ks || typeof ks !== 'object') return null;
  const k = ks as Record<string, unknown>;
  const classification = typeof k.classification === 'string' ? k.classification : 'unknown';
  const rawChanges = Array.isArray(k.changes) ? k.changes : [];
  const changes: KbSyncChange[] = [];
  for (const c of rawChanges) {
    if (!c || typeof c !== 'object') continue;
    const cc = c as Record<string, unknown>;
    const file = typeof cc.file === 'string' ? cc.file : '';
    const op =
      typeof cc.op === 'string' && KB_SYNC_OPS.has(cc.op) ? (cc.op as KbSyncChange['op']) : null;
    const summary = typeof cc.summary === 'string' ? cc.summary : '';
    if (!file || !op) continue;
    changes.push({ file, op, summary });
  }
  return { classification, changes };
}

/** Parse the optional `globalCandidates` array (portable house-standard articles)
 *  the learning agent may emit for cross-repo global-KB promotion. Defensive:
 *  entries missing title/body/tech are dropped; unknown categories fall back to
 *  tech_pattern; ids are deduped. */
export function parseGlobalCandidates(raw: unknown): GlobalCandidate[] {
  let obj: Record<string, unknown> | null = null;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>;
  } else if (typeof raw === 'string') {
    const parsed = parseJsonLoose(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      obj = parsed as Record<string, unknown>;
    }
  }
  const arr = obj?.globalCandidates ?? obj?.global_candidates;
  if (!Array.isArray(arr)) return [];
  const out: GlobalCandidate[] = [];
  const taken = new Set<string>();
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    const title = typeof c.title === 'string' ? c.title.trim() : '';
    const body = typeof c.body === 'string' ? c.body : '';
    const tech = typeof c.tech === 'string' ? c.tech.trim() : '';
    if (!title || !body.trim() || !tech) continue;
    const category =
      typeof c.category === 'string' && GLOBAL_CANDIDATE_CATEGORIES.has(c.category)
        ? (c.category as GlobalCandidate['category'])
        : 'tech_pattern';
    let id = slugify(title) || 'candidate';
    for (let n = 2; taken.has(id); n++) id = `${slugify(title) || 'candidate'}-${n}`;
    taken.add(id);
    out.push({ id, title, body, category, tech });
  }
  return out;
}

/** Discard the learning agent's structured-KB edits (Feature KB Sync) when the user
 *  rejects them: `checkout` restores tracked modifications + deletions, `clean` removes
 *  new files. Scoped to `.claude/knowledge_base` — investigations/ is written AFTER this
 *  and learnings live elsewhere, so neither is affected. Best-effort (a brand-new repo
 *  with no tracked KB makes checkout a no-op). */
async function revertKbSync(worktree: string): Promise<void> {
  await execFileP('git', [
    '-C',
    worktree,
    'checkout',
    'HEAD',
    '--',
    '.claude/knowledge_base',
  ]).catch(() => undefined);
  await execFileP('git', ['-C', worktree, 'clean', '-fdq', '--', '.claude/knowledge_base']).catch(
    () => undefined,
  );
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
    const op =
      typeof entry.op === 'string' && KB_SYNC_OPS.has(entry.op)
        ? (entry.op as LearningEntry['op'])
        : 'insert';
    const targetId =
      typeof entry.targetId === 'string' && entry.targetId.length > 0 ? entry.targetId : undefined;
    const title = typeof entry.title === 'string' ? entry.title : '';
    const body = typeof entry.body === 'string' ? entry.body : '';
    // A delete only needs its targetId; insert/update need real content.
    if (op === 'delete') {
      if (!targetId) continue;
      out.push({ id: targetId, title: title || targetId, body, op: 'delete', targetId });
      continue;
    }
    if (!title || !body) continue;
    const id = typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : slugify(title);
    out.push({ id, title, body, op, targetId });
  }
  return out;
}

function stubLearning(detect: LearningDetect): LearningEntry[] {
  const entry: LearningEntry = {
    id: slugify(detect.taskTitle || 'workflow-run'),
    op: 'insert',
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

/** A learning already present in .claude/learnings/ (filename slug = id). */
interface ExistingLearning {
  id: string;
  title: string;
  /** Full on-disk file content (the diff baseline for an update/delete). */
  body: string;
}

/** A reconciled, ready-to-apply learning op: existing-set validation and the
 *  insert-id collision guard are already resolved, so apply() and the diff builder
 *  consume the SAME plan and never disagree on what is written. */
interface PlannedLearningOp {
  op: 'insert' | 'update' | 'delete';
  /** Final filename slug written/removed. */
  id: string;
  title: string;
  /** Rendered new body (without the reviewer note, appended at write time); ''
   *  for a delete. */
  newBody: string;
  /** Prior on-disk body; '' for an insert. */
  oldBody: string;
}

/** Read the existing learnings so the agent can reconcile against them and the
 *  diff/apply can update/delete by id. Missing dir -> []. */
export async function readExistingLearnings(worktree: string): Promise<ExistingLearning[]> {
  const dir = path.join(worktree, '.claude', 'learnings');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: ExistingLearning[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    try {
      const body = await readFile(path.join(dir, name), 'utf8');
      const title = (body.match(/^#\s+(.+)$/m)?.[1] ?? name.slice(0, -3)).trim();
      out.push({ id: name.slice(0, -3), title, body });
    } catch {
      // unreadable -> skip
    }
  }
  return out;
}

function renderLearningBody(entry: LearningEntry): string {
  return `# ${entry.title}\n\n${entry.body}`;
}

/** First ~200 chars of a learning's prose (minus its `# heading`) — the bounded
 *  context the prompt shows so the agent can dedup/update without the full body. */
function learningExcerpt(body: string): string {
  const prose = body.replace(/^#\s+.+$/m, '').trim();
  return prose.length > 200 ? `${prose.slice(0, 200)}…` : prose;
}

/** Pick a free slug for an insert so a title that collides with an existing
 *  learning never silently overwrites it (the prior append-only data-loss bug). */
function resolveInsertId(slug: string, taken: Set<string>): string {
  const base = slug || 'learning';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Validate the parsed entries against the existing set and resolve each into a
 *  concrete op: an update/delete whose targetId is unknown is downgraded (update
 *  -> insert, delete -> dropped) so a hallucinated target never overwrites or
 *  removes the wrong file. logger is set only on the authoritative apply pass. */
export function planLearningReconciliation(
  entries: LearningEntry[],
  existing: ExistingLearning[],
  logger?: StepContext['logger'],
): PlannedLearningOp[] {
  const byId = new Map(existing.map((e) => [e.id, e]));
  const taken = new Set(existing.map((e) => e.id));
  const plan: PlannedLearningOp[] = [];
  for (const e of entries) {
    if (e.op === 'delete') {
      const target = e.targetId ? byId.get(e.targetId) : undefined;
      if (!target) {
        logger?.warn({ targetId: e.targetId }, 'learning delete names an unknown id — dropped');
        continue;
      }
      plan.push({
        op: 'delete',
        id: target.id,
        title: target.title,
        newBody: '',
        oldBody: target.body,
      });
      continue;
    }
    if (e.op === 'update' && e.targetId && byId.has(e.targetId)) {
      const target = byId.get(e.targetId)!;
      plan.push({
        op: 'update',
        id: target.id,
        title: e.title,
        newBody: renderLearningBody(e),
        oldBody: target.body,
      });
      continue;
    }
    if (e.op === 'update') {
      logger?.warn(
        { targetId: e.targetId },
        'learning update names an unknown id — inserting instead',
      );
    }
    const id = resolveInsertId(e.id || slugify(e.title), taken);
    taken.add(id);
    plan.push({ op: 'insert', id, title: e.title, newBody: renderLearningBody(e), oldBody: '' });
  }
  return plan;
}

/** The planned ops as diff files for the form-gate viewer (synthesized — the new
 *  learning files are not written until apply). */
export function learningOpsToDiffFiles(plan: PlannedLearningOp[]): CommitDiffFile[] {
  return plan.map((p) => ({
    path: path.join('.claude', 'learnings', `${p.id}.md`),
    status: p.op === 'insert' ? 'added' : p.op === 'delete' ? 'deleted' : 'modified',
    binary: false,
    truncated: false,
    oldContent: p.oldBody,
    newContent: p.newBody,
  }));
}

/** Apply the reconciled plan to the worktree: write inserts/updates, unlink
 *  deletes. Gated by the form's writeFiles toggle in the caller. */
export async function applyLearningOps(
  worktree: string,
  plan: PlannedLearningOp[],
  reviewerNote: string,
): Promise<{ written: string[]; deleted: string[] }> {
  const dir = path.join(worktree, '.claude', 'learnings');
  await mkdir(dir, { recursive: true });
  const note = reviewerNote.trim() ? `\n\n## Reviewer note\n${reviewerNote.trim()}\n` : '';
  const written: string[] = [];
  const deleted: string[] = [];
  for (const p of plan) {
    const file = path.join(dir, `${p.id}.md`);
    if (p.op === 'delete') {
      await rm(file, { force: true });
      deleted.push(path.relative(worktree, file));
    } else {
      await writeFile(file, `${p.newBody}\n${note}`, 'utf8');
      written.push(path.relative(worktree, file));
    }
  }
  return { written, deleted };
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
    const worktree = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
    const worktreePath =
      (worktree?.output as { worktreePath?: string } | null)?.worktreePath ?? ctx.workspacePath;
    const hasGit = await pathExists(path.join(worktreePath, '.git'));
    const existingLearnings = (await readExistingLearnings(worktreePath))
      .slice(0, 60)
      .map((e) => ({ id: e.id, title: e.title, excerpt: learningExcerpt(e.body) }));
    const implementOutput = (implement?.output as ImplementOutput | null) ?? {};
    const verifyOutput = (verify?.output as VerifyOutput | null) ?? {};
    const commitOutput = (commit?.output as CommitOutput | null) ?? {};
    const historyDigest = await buildTaskHistoryDigest(ctx.db, ctx.taskId);
    const repositoryId =
      (
        await ctx.db.query.tasks.findFirst({
          where: eq(schema.tasks.id, ctx.taskId),
          columns: { repositoryId: true },
        })
      )?.repositoryId ?? null;
    const repoStack = repositoryId ? await loadRepoStackAnchors(ctx.db, repositoryId) : null;
    const existingGlobalArticles = repoStack
      ? await loadActiveGlobalArticlesForStack(ctx.db, [
          repoStack.anchors.framework,
          repoStack.language,
          repoStack.anchors.database,
        ])
      : [];
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
      historyDigest,
      existingLearnings,
      repoStack,
      existingGlobalArticles,
      worktreePath,
      knowledgeDiffArtifactPath: hasGit
        ? path.join(worktreePath, '.haive', KNOWLEDGE_DIFF_ARTIFACT_NAME)
        : null,
    };
  },

  async prepareForm(ctx, detected, llmOutput): Promise<void> {
    // Post-llm, pre-form: materialise the knowledge-diff the form's web viewer
    // reads. The agent's Feature KB Sync edits are on disk now (git side); the
    // learning insert/update/delete ops are synthesized from the parsed output
    // against the existing learnings (those files are not written until apply).
    // Always writes — an empty diff renders as "No changes to show". Best-effort:
    // never block the form on a diff-build error.
    if (!detected.knowledgeDiffArtifactPath) return;
    try {
      const existing = await readExistingLearnings(detected.worktreePath);
      const parsed = parseLearningOutput(llmOutput ?? null) ?? [];
      const plan = planLearningReconciliation(parsed, existing);
      await buildKnowledgeDiffArtifact(detected.worktreePath, gitRun, learningOpsToDiffFiles(plan));
    } catch (err) {
      ctx.logger.warn({ err }, 'failed to build learning knowledge diff artifact');
    }
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
          ? '{ "entries": [ { "id": "<kebab-case>", "op": "insert|update|delete", "targetId": "<existing learning id; only for update/delete>", "title": "<short>", "body": "<markdown>" } ], "kbSync": { "classification": "new_feature|feature_update|feature_removal|bug_fix|refactor", "changes": [ { "file": "<repo-relative .md path>", "op": "insert|update|delete", "summary": "<one line>" } ] }, "investigation": { "title": "<short>", "symptoms": "<observable symptoms + the EXACT error strings/messages, verbatim>", "root_cause": "<why/how the bug happened>", "lesson": "<durable lesson for future runs>", "scope": "local | global" } }'
          : '{ "entries": [ { "id": "<kebab-case>", "op": "insert|update|delete", "targetId": "<existing learning id; only for update/delete>", "title": "<short>", "body": "<markdown>" } ], "kbSync": { "classification": "new_feature|feature_update|feature_removal|bug_fix|refactor", "changes": [ { "file": "<repo-relative .md path>", "op": "insert|update|delete", "summary": "<one line>" } ] } }',
        'Each entry must be a reusable lesson grounded in the workflow run. Avoid generic advice.',
        '',
        'LEARNINGS RECONCILIATION — you are shown the EXISTING learnings below. For each lesson decide an `op`:',
        '- "insert" (default) for a NEW lesson no existing learning covers.',
        '- "update" with `targetId` = an existing learning id when refining/replacing it; put the FULL new content in `body`.',
        '- "delete" with `targetId` = an existing learning id when this run proved that lesson WRONG or obsolete.',
        'Only use a `targetId` that EXACTLY matches an id in the existing list (an unknown target is treated as an insert, or dropped for delete). Do not duplicate a lesson that already exists — update it instead.',
        '',
        'KNOWLEDGE BASE SYNC — before emitting the JSON, keep the project knowledge base in sync with what this task changed:',
        '1. CLASSIFY the task: new_feature (adds capability) | feature_update (changes existing behavior) | feature_removal (removes capability) | bug_fix | refactor.',
        '2. bug_fix / refactor → SKIP KB edits (documented behavior is unchanged); set "changes": []. (A bug fix is still captured by the investigation below.)',
        '3. new_feature / feature_update / feature_removal → find where the feature belongs (search `rag_search` FIRST, then `.claude/knowledge_base/INDEX.md`), then EDIT the structured `.claude/knowledge_base/*.md` files IN PLACE with your file tools: INSERT a section for a new feature, UPDATE the existing section for a change (correct now-stale text; leave no contradictions), DELETE the section for a removal. Document business purpose, key rules, tables/fields, and access control using the target file’s conventions. Keep `INDEX.md` in sync when you add or remove a file.',
        '4. KB GAP DETECTION: if the run surfaced domain knowledge that was MISSING from the KB (a rule discovered from code, a constraint, an edge case), append it to the right KB file.',
        '5. Report EVERY knowledge_base file you changed in `kbSync.changes`. Do NOT edit `.claude/knowledge_base/investigations/` — that is recorded separately below.',
        detected.isBugFix
          ? 'This task was a BUG FIX: ALSO produce an `investigation`. In `symptoms`, lead with the observable symptoms and quote the EXACT error strings/messages verbatim — these are the lexical anchor future searches match on; name the affected feature/area. Give the root cause (why/how the bug existed, grounded in the implementation) and the durable lesson for future work. Set its `scope` to "global" ONLY when the lesson is a reusable house standard for any project of this stack (not specific to this repo); otherwise "local".'
          : '',
        '',
        'GLOBAL KB CANDIDATES (optional, separate from the per-repo learnings above): if this run produced REUSABLE, PORTABLE house-standard knowledge about a PUBLIC tech (a framework/library/language/datastore — NOT this repo\'s own code, names, or paths), add a `globalCandidates` array to the JSON: [ { "title": "<short>", "category": "tech_pattern|best_practice|anti_pattern|quick_reference", "tech": "<public tech slug, e.g. drupal, php, mariadb>", "body": "<full portable markdown article, no repo-specific names/paths>" } ]. Omit it or use [] when nothing is genuinely portable. If a candidate covers the SAME topic as one of the existing global articles shown below, author `body` as the FULL UPDATED article: keep the existing wording VERBATIM where unchanged and only add or adjust what this task learned — the body is diffed against the existing article for human approval, so minimize churn.',
        '',
        `Task title: ${detected.taskTitle || '(untitled)'}`,
        `Task description: ${detected.taskDescription || '(none)'}`,
        `Feature/area: ${detected.feature ?? '(unspecified)'}`,
        `Implementation summary: ${detected.implementSummary || '(none)'}`,
        `Verification passed: ${detected.verifyPassed}`,
        `Commit sha: ${detected.commitSha ?? '(none)'}`,
        `Files touched: ${detected.filesTouched.join(', ') || '(none)'}`,
        '',
        '=== Existing learnings (reconcile against these; use their id as targetId) ===',
        detected.existingLearnings.length > 0
          ? detected.existingLearnings.map((l) => `- ${l.id} — ${l.title}: ${l.excerpt}`).join('\n')
          : '(none yet)',
        '',
        '=== Existing global house-standard articles for this stack (to UPDATE one, re-use its tech and author the full merged body) ===',
        detected.existingGlobalArticles.length > 0
          ? detected.existingGlobalArticles
              .map((a) => `--- ${a.title} ---\n${a.body.slice(0, 1500)}`)
              .join('\n\n')
          : '(none)',
        '',
        '=== What happened during this task (mine this — it is the real, persisted run history) ===',
        detected.historyDigest.text,
        '',
        'Ground EVERY learning, the investigation, and the KB sync in the SPECIFIC diagnoses, findings, human reactions, and any user steering (mid-run course-corrections) above: quote the real errors/symptoms, name what was planned or implemented wrong and how it was resolved, and fold the human reviewer reactions and steering directives in. A mid-run steer marks a spot where the agent drifted — capture the durable lesson (or runbook step) that would have avoided the need to steer. Do NOT write generic advice. For a bug, the investigation symptoms + root cause must cite the actual diagnosis; the KB sync should reflect what the reviewers and the human actually flagged.',
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
    const kbSync = parseKbSync(llmOutput ?? null);
    const kbChanged = (kbSync?.changes.length ?? 0) > 0;
    const globalCandidates = parseGlobalCandidates(llmOutput ?? null);
    const infoSections: InfoSection[] = [];
    const insertCount = entries.filter((e) => e.op === 'insert').length;
    const updateCount = entries.filter((e) => e.op === 'update').length;
    const deleteCount = entries.filter((e) => e.op === 'delete').length;
    const opTag = (e: LearningEntry): string =>
      e.op === 'update'
        ? `UPDATE → ${e.targetId}`
        : e.op === 'delete'
          ? `REMOVE → ${e.targetId}`
          : 'NEW';
    if (entries.length > 0) {
      infoSections.push({
        title: `Drafted learnings (${insertCount} new, ${updateCount} updated, ${deleteCount} removed)`,
        preview: entries
          .map((e) => `[${opTag(e)}] ${e.title}`)
          .join('; ')
          .slice(0, 80),
        body: entries
          .map((e) =>
            e.op === 'delete'
              ? `### [${opTag(e)}] ${e.title}`
              : `### [${opTag(e)}] ${e.title}\n\n${e.body}`,
          )
          .join('\n\n---\n\n'),
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
    if (kbChanged && kbSync) {
      infoSections.push({
        title: `Knowledge base sync (${kbSync.classification}, ${kbSync.changes.length} file${kbSync.changes.length === 1 ? '' : 's'})`,
        preview: kbSync.changes
          .map((c) => `${c.op} ${c.file}`)
          .join('; ')
          .slice(0, 80),
        body: kbSync.changes
          .map((c) => `- **${c.op.toUpperCase()}** \`${c.file}\`\n  ${c.summary || '(no summary)'}`)
          .join('\n'),
        defaultOpen: true,
      });
    }
    if (globalCandidates.length > 0) {
      infoSections.push({
        title: `Global KB candidates (${globalCandidates.length})`,
        preview: globalCandidates
          .map((c) => c.title)
          .join('; ')
          .slice(0, 80),
        body: globalCandidates
          .map((c) => `### [${c.category} · ${c.tech}] ${c.title}\n\n${c.body}`)
          .join('\n\n---\n\n'),
        defaultOpen: false,
      });
    }
    return {
      title: 'Phase 8: Learning capture',
      description: [
        `Task: ${detected.taskTitle || '(untitled)'}`,
        `Verification: ${detected.verifyPassed ? 'passed' : 'did not pass'}`,
        detected.isBugFix ? 'Bug fix — a knowledge-base investigation was drafted below.' : '',
        kbChanged
          ? 'Feature KB sync — the agent updated the knowledge base; review the changes below.'
          : '',
        'Review the drafts below; approve to write them, add a note to refine, or untick to skip.',
      ]
        .filter(Boolean)
        .join('\n'),
      infoSections: infoSections.length > 0 ? infoSections : undefined,
      fields: [
        {
          type: 'checkbox',
          id: 'writeFiles',
          label:
            entries.length > 0
              ? `Apply learning changes (${insertCount} new, ${updateCount} updated, ${deleteCount} removed) to .claude/learnings/`
              : 'Write learning entries to .claude/learnings/',
          default: true,
        },
        ...(kbChanged && kbSync
          ? [
              {
                type: 'checkbox' as const,
                id: 'keepKbSync',
                label: `Keep the knowledge-base sync edits (${kbSync.changes.length} file${kbSync.changes.length === 1 ? '' : 's'}); untick to revert them`,
                default: true,
              },
            ]
          : []),
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
        ...(globalCandidates.length > 0 && detected.repoStack
          ? [
              {
                type: 'multi-select' as const,
                id: 'acceptGlobalCandidates',
                label: 'Promote these as GLOBAL KB drafts (cross-repo house standards)',
                options: globalCandidates.map((c) => ({
                  value: c.id,
                  label: c.title,
                  description: `${c.category} · ${c.tech}`,
                })),
                defaults: [] as string[],
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
      keepKbSync?: boolean;
      writeInvestigation?: boolean;
      promoteInvestigationGlobal?: boolean;
      acceptGlobalCandidates?: string[];
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

    // Feature KB Sync: the agent edited .claude/knowledge_base/*.md in the worktree during
    // the LLM phase. Revert those edits when the reviewer unticked "keep KB sync". Done
    // BEFORE writing the investigation (which lands under knowledge_base/investigations/),
    // so a kept investigation survives the revert.
    const kbSync = parseKbSync(args.llmOutput ?? null);
    const kbHasChanges = (kbSync?.changes.length ?? 0) > 0;
    let kbReverted = false;
    if (kbHasChanges && values.keepKbSync === false) {
      await revertKbSync(worktreePath);
      kbReverted = true;
      ctx.logger.info({ files: kbSync!.changes.length }, 'feature KB sync reverted by reviewer');
    }

    const parsed = parseLearningOutput(args.llmOutput ?? null);
    const source: 'llm' | 'stub' = parsed && parsed.length > 0 ? 'llm' : 'stub';
    const entries = parsed && parsed.length > 0 ? parsed : stubLearning(args.detected);
    const existingLearnings = await readExistingLearnings(worktreePath);
    const plan = planLearningReconciliation(entries, existingLearnings, ctx.logger);
    let written: string[] = [];
    let deleted: string[] = [];
    if (values.writeFiles !== false) {
      const res = await applyLearningOps(worktreePath, plan, reviewerNote);
      written = res.written;
      deleted = res.deleted;
    }

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

    // General house-standard candidates: promote each ticked candidate as a global
    // KB draft, version-anchored from the repo's onboarding stack so the topicKey
    // matches/updates an existing article deterministically (the LLM's free-form
    // facets drift). Investigations above stay standalone (no topicKey) by design.
    const globalCandidates = parseGlobalCandidates(args.llmOutput ?? null);
    const acceptedIds = new Set(values.acceptGlobalCandidates ?? []);
    const promotedCandidates: string[] = [];
    if (acceptedIds.size > 0 && args.detected.repoStack) {
      const { anchors, projectName } = args.detected.repoStack;
      for (const c of globalCandidates.filter((c) => acceptedIds.has(c.id))) {
        const facets = techAnchorFacets(c.tech, {}, anchors);
        const promo = await promoteToGlobalKbDraft(
          ctx.db,
          {
            userId: ctx.userId,
            taskId: ctx.taskId,
            title: c.title,
            body: c.body,
            category: c.category,
            facets,
            topicKey: globalKbTopicKey(c.category, facets, c.tech) ?? undefined,
            projectName: projectName ?? undefined,
          },
          ctx.logger,
        );
        if (promo) promotedCandidates.push(`global-kb:${promo.id}`);
      }
    }

    ctx.logger.info(
      {
        entries: entries.length,
        written: written.length,
        deleted: deleted.length,
        investigationWritten,
        kbClassification: kbSync?.classification ?? null,
        kbChanged: kbHasChanges,
        kbReverted,
        promotedCandidates: promotedCandidates.length,
        source,
      },
      'learning capture complete',
    );
    return {
      entries,
      written,
      deleted,
      investigationWritten,
      kbSync,
      kbReverted,
      promotedCandidates,
      source,
    };
  },
};
