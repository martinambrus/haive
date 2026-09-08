import path from 'node:path';
import { CONFIG_KEYS, configService, type FormSchema, type FormValues } from '@haive/shared';
import { KB_DIR } from '@haive/shared/knowledge-paths';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { pathExists } from '../onboarding/_helpers.js';
import { agentDefinitionGuidance } from '../_retrieval-guidance.js';
import { parseJsonLoose } from '../_fenced-json.js';
import { commitKnowledgeTrees, gitRun, revertKnowledgeBase } from './_kb-commit.js';
import { EXTERNAL_KB_DIFF_ARTIFACT_NAME, buildKnowledgeDiffArtifact } from './_knowledge-diff.js';
import {
  externalCommitBlock,
  resolveExternalDrift,
  stampExternalWatermark,
  type ExternalCommit,
} from './_external-drift.js';

/**
 * Bring the knowledge base in line with commits Haive did not make.
 *
 * The KB describes how the code currently is, and until this step existed nothing told it
 * about a teammate's push, a commit the user made from their own editor, or a plan-mirror
 * PULL merging origin into the checkout. `11-phase-8-learning` builds its KB prompt from
 * the task's own `filesTouched`, so external work was invisible to it by construction.
 *
 * Stale KB is worse than absent KB here, and structurally so: `03-phase-0a-discovery` and
 * `04-phase-0b-pre-planning` read `KB_DIR/*.md` straight into their prompts, and
 * `applyKnowledgeReserve` reserves two slots of every RAG page for KB chunks — so prose
 * describing code that no longer exists is GUARANTEED promotion into every agent's
 * context. A correct RAG index makes this louder, not quieter.
 *
 * That is also why the step sits at 1.8 rather than beside the learning gate at the tail:
 * the harm is the read at 03/04, and a catch-up that lands after it leaves THIS task
 * planning against fiction. Running here also means `02-pre-rag-sync` (index 2) indexes
 * the refreshed KB in the same run.
 */

const DEFAULT_MESSAGE = 'docs: sync knowledge base with external commits';

interface KbChange {
  file: string;
  op: string;
  summary: string;
}

export interface ExternalKbSyncDetect {
  repositoryId: string | null;
  worktreePath: string;
  branchPoint: string | null;
  since: string | null;
  firstRun: boolean;
  measured: boolean;
  commits: ExternalCommit[];
  changedPaths: string[];
  commitsOmitted: number;
  pathsOmitted: number;
  reason: string | null;
  hasKbDir: boolean;
  /** Read by the web gate to render the editable diff viewer, the same key the learning
   *  and commit gates set. PREDICTED here rather than returned from `prepareForm`: the
   *  runner persists `detectOutput` after detect and writes only `formSchema` at the
   *  pre-form seam (step-runner.ts), so a path assigned in `prepareForm` would never
   *  reach the browser. The file itself is written there, where the agent's edits exist. */
  knowledgeDiffArtifactPath: string | null;
}

export interface ExternalKbSyncApply {
  decision: 'applied' | 'declined' | 'nothing_to_review' | 'tracking_started' | 'not_measured';
  commitsReviewed: number;
  /** The commit the repository has now been reviewed through, or null when nothing was
   *  stamped. */
  reviewedThrough: string | null;
  committed: boolean;
  commitSha: string | null;
  /** Lifted verbatim into the step's "What the agent did" panel by
   *  `resolveCuratedSummary`, so this recap costs no CLI call. */
  summary: string;
}

export function parseKbChanges(llmOutput: unknown): KbChange[] {
  const raw = typeof llmOutput === 'string' ? parseJsonLoose(llmOutput) : llmOutput;
  const obj = raw as { changes?: unknown } | null;
  if (!obj || !Array.isArray(obj.changes)) return [];
  const out: KbChange[] = [];
  for (const c of obj.changes) {
    const entry = c as { file?: unknown; op?: unknown; summary?: unknown };
    if (typeof entry.file !== 'string' || entry.file.length === 0) continue;
    out.push({
      file: entry.file,
      op: typeof entry.op === 'string' ? entry.op : 'update',
      summary: typeof entry.summary === 'string' ? entry.summary : '',
    });
  }
  return out;
}

function buildPrompt(d: ExternalKbSyncDetect): string {
  return [
    agentDefinitionGuidance(
      'knowledge-curator',
      [
        'If a `.claude/agents/knowledge-curator.md` agent definition exists in the repo, follow it;',
        'otherwise follow the protocol below.',
      ].join('\n'),
    ),
    'Commits reached this repository WITHOUT going through this workflow — a teammate pushed,',
    'someone committed from their own editor, or a pull merged other work in. The knowledge',
    `base under \`${KB_DIR}/\` still describes the code as it was before them.`,
    '',
    'Your job is to make the knowledge base true again. It describes how the project WORKS —',
    'it is not a changelog, so do not add an entry saying that a change happened.',
    '',
    '## Commits since the knowledge base was last brought up to date',
    '',
    externalCommitBlock(d),
    '',
    '## Files those commits touched',
    '',
    ...d.changedPaths.map((p) => `- ${p}`),
    ...(d.pathsOmitted > 0
      ? [
          `- (+${d.pathsOmitted} further path(s) not listed — say so in your summary rather ` +
            'than implying you saw the whole change)',
        ]
      : []),
    '',
    '## What to do',
    '',
    `1. READ the files above from disk before you write anything. The commit list tells you`,
    '   WHERE to look and never what the code now says.',
    `2. Find where each change belongs in \`${KB_DIR}/\`: search with \`rag_search\` first, then`,
    `   \`${KB_DIR}/INDEX.md\`. The RAG index was written before these commits landed, so for`,
    '   any file they touched it is not merely stale but WRONG — treat a hit as a pointer to',
    '   a path, then read that path from disk.',
    '3. EDIT the `.md` files in place with your file tools: UPDATE the section a change makes',
    '   inaccurate, INSERT one for a capability that is now there and is described nowhere,',
    '   DELETE one for a capability that is gone. Leave no contradictions behind. Keep',
    '   `INDEX.md` in sync when you add or remove a file.',
    '4. Change NOTHING for a commit that altered no behaviour the knowledge base describes —',
    '   a refactor, a formatting pass, a dependency bump. Writing an entry for one of those',
    '   costs every future run that reads it. An empty `changes` array is a good answer.',
    '',
    'Do NOT edit source code, tests, or anything outside the knowledge base. Another step',
    "owns this task's own implementation; you are only reconciling the documentation.",
    '',
    'Emit ONE JSON object inside a ```json fenced code block:',
    '{ "changes": [ { "file": "<repo-relative .md path>", "op": "insert|update|delete", ' +
      '"summary": "<one line>" } ], "summary": "<one paragraph: what you changed and why, ' +
      'or why nothing needed changing>" }',
  ].join('\n');
}

export const externalKbSyncStep: StepDefinition<ExternalKbSyncDetect, ExternalKbSyncApply> = {
  metadata: {
    id: '01e-external-kb-sync',
    workflowType: 'workflow',
    // After 01c-ddev-env (1.6), so the worktree exists and these edits land on the task
    // branch like every other KB write. Before 02-pre-rag-sync (2), so the refreshed KB is
    // indexed this run, and before 03-phase-0a-discovery (3), which reads the KB into its
    // prompt — that read is the whole reason this is not at the tail.
    index: 1.8,
    title: 'Knowledge base catch-up',
    description:
      'Brings the knowledge base in line with commits that reached this repository outside ' +
      'the workflow. Skipped when nothing landed since the last catch-up.',
    requiresCli: true,
    // A knowledge base one task behind is a smaller problem than a task that cannot run.
    allowSkip: true,
  },

  async shouldRun(): Promise<boolean> {
    return (await configService.getBoolean(CONFIG_KEYS.EXTERNAL_SYNC_ENABLED, true)) !== false;
  },

  async detect(ctx: StepContext): Promise<ExternalKbSyncDetect> {
    await ctx.emitProgress('Looking for commits made outside the workflow...');
    const drift = await resolveExternalDrift(ctx, 'kb');
    // The tree the drift was MEASURED in, never ctx.workspacePath — that is only the
    // fallback for a task with no worktree, and using it here would read and commit a
    // different tree than the one the sandboxed agent edits.
    const worktreePath = drift.worktreePath;
    const hasKbDir = await pathExists(path.join(worktreePath, KB_DIR));
    return {
      repositoryId: drift.repositoryId,
      worktreePath,
      branchPoint: drift.branchPoint,
      since: drift.since,
      firstRun: drift.firstRun,
      measured: drift.measured,
      commits: drift.commits,
      changedPaths: drift.changedPaths,
      commitsOmitted: drift.commitsOmitted,
      pathsOmitted: drift.pathsOmitted,
      reason: drift.reason,
      hasKbDir,
      knowledgeDiffArtifactPath:
        hasKbDir && drift.commits.length > 0
          ? path.join(worktreePath, '.haive', EXTERNAL_KB_DIFF_ARTIFACT_NAME)
          : null,
    };
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    // No `toolProfile` — unlike the plan reconcile, this agent EDITS files on disk and
    // needs the full surface to do it.
    timeoutMs: 30 * 60 * 1000,
    preForm: true,
    // A catch-up that could not run must never block the task it rides. The runner
    // degrades to `llmOutput = null`, the form finds no changes, and the watermark simply
    // does not move — so the next task tries the same range again.
    optional: true,
    skipIf: (args) => {
      const d = args.detected as ExternalKbSyncDetect | null;
      return !d?.repositoryId || !d.hasKbDir || d.commits.length === 0;
    },
    buildPrompt: (args) => buildPrompt(args.detected as ExternalKbSyncDetect),
    bypassStub: () => ({ changes: [], summary: '' }),
  },

  async prepareForm(ctx, detected, _llmOutput): Promise<void> {
    // Post-llm, pre-form: the agent's edits are on disk now, so this is the first moment
    // the gate's diff can be built. Always writes — an empty diff renders as "No changes
    // to show" rather than a fetch error — and never throws, because a failed diff costs
    // the gate its editability, not its decision.
    if (!detected.knowledgeDiffArtifactPath) return;
    try {
      await buildKnowledgeDiffArtifact(detected.worktreePath, gitRun, [], {
        pathspecs: [KB_DIR],
        artifactName: EXTERNAL_KB_DIFF_ARTIFACT_NAME,
      });
    } catch (err) {
      ctx.logger.warn({ err }, 'failed to build external knowledge-base diff artifact');
    }
  },

  form(_ctx, detected, llmOutput): FormSchema | null {
    // Nothing landed, nothing measurable, or tracking starts here — all three are silent.
    // Parking a form on any of them asks the developer to confirm that nothing happened.
    if (!detected.repositoryId || detected.commits.length === 0) return null;
    const changes = parseKbChanges(llmOutput);
    if (changes.length === 0) return null;

    const n = detected.commits.length;
    return {
      title: 'Knowledge base catch-up',
      description: [
        `${n} commit${n === 1 ? '' : 's'} reached this repository outside the workflow` +
          (detected.commitsOmitted > 0 ? ` (+${detected.commitsOmitted} not listed)` : '') +
          '. The knowledge-base edits below bring it back in line.',
        '',
        externalCommitBlock(detected),
        '',
        ...changes.map((c) => `- \`${c.file}\` — ${c.op}: ${c.summary}`),
        '',
        detected.knowledgeDiffArtifactPath
          ? 'Review the diff below — it can be edited inline before it is committed.'
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
      fields: [
        {
          type: 'checkbox',
          id: 'applyKbSync',
          label: 'Apply these knowledge-base updates',
          // Ticked by default: the step exists to keep the knowledge base current, and a
          // form that starts empty is one nobody fills in. Nothing is written until it is
          // submitted either way.
          default: true,
        },
        {
          type: 'textarea',
          id: 'commitMessage',
          label: 'Commit message',
          rows: 2,
          default: DEFAULT_MESSAGE,
        },
      ],
      submitLabel: 'Apply',
    };
  },

  async apply(ctx, args): Promise<ExternalKbSyncApply> {
    const d = args.detected;
    const base: ExternalKbSyncApply = {
      decision: 'not_measured',
      commitsReviewed: 0,
      reviewedThrough: null,
      committed: false,
      commitSha: null,
      summary: '',
    };

    // "We could not tell what changed" and "nothing changed" produce the same empty commit
    // list, so only the measured case is ever allowed to move the watermark.
    if (!d.repositoryId || !d.measured || !d.branchPoint) {
      return { ...base, summary: d.reason ?? 'external changes could not be measured' };
    }

    const stamp = async (): Promise<void> => {
      await stampExternalWatermark(ctx.db, d.repositoryId!, 'kb', d.branchPoint!);
    };

    if (d.firstRun) {
      await stamp();
      return {
        ...base,
        decision: 'tracking_started',
        reviewedThrough: d.branchPoint,
        summary:
          'No catch-up baseline existed for this repository, so tracking starts at the ' +
          'current commit. Earlier history is not reviewed — reaching back through it in ' +
          'one pass produces a confident, truncated rewrite.',
      };
    }

    if (d.commits.length === 0) {
      await stamp();
      return {
        ...base,
        decision: 'nothing_to_review',
        reviewedThrough: d.branchPoint,
        summary: d.reason ?? 'No commits reached this repository outside the workflow.',
      };
    }

    const changes = parseKbChanges(args.llmOutput);
    const values = (args.formValues ?? {}) as FormValues;
    // No form is parked when the agent proposed nothing, so an absent value there means
    // "there was nothing to accept", not "the user said no".
    const accepted = changes.length > 0 ? values.applyKbSync === true : true;

    if (!accepted) {
      await revertKnowledgeBase(d.worktreePath);
      // Stamped anyway: a person was SHOWN these commits and decided against folding them
      // in, which is a review. Re-asking every future task about the same range is the
      // nagging failure mode, and the step's own Retry is the escape hatch for the other
      // reading ("the agent got it wrong"), which is what Retry is for.
      await stamp();
      return {
        ...base,
        decision: 'declined',
        commitsReviewed: d.commits.length,
        reviewedThrough: d.branchPoint,
        summary: `Declined the proposed knowledge-base updates for ${d.commits.length} external commit(s); the edits were reverted.`,
      };
    }

    const result =
      changes.length > 0
        ? await commitKnowledgeTrees({
            workspace: d.worktreePath,
            message:
              (typeof values.commitMessage === 'string' ? values.commitMessage : '').trim() ||
              DEFAULT_MESSAGE,
            db: ctx.db,
            userId: ctx.userId,
            taskId: ctx.taskId,
          })
        : { committed: false, commitSha: null, message: 'nothing to commit' };

    await stamp();
    const agentSummary =
      typeof (args.llmOutput as { summary?: unknown } | null)?.summary === 'string'
        ? ((args.llmOutput as { summary: string }).summary ?? '')
        : '';
    return {
      decision: 'applied',
      commitsReviewed: d.commits.length,
      reviewedThrough: d.branchPoint,
      committed: result.committed,
      commitSha: result.commitSha,
      summary:
        agentSummary.trim() ||
        `Reviewed ${d.commits.length} external commit(s) and updated ${changes.length} knowledge-base file(s).`,
    };
  },
};
