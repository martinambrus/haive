import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { KB_COMMIT_DIFF_ARTIFACT_NAME, buildKnowledgeDiffArtifact } from './_knowledge-diff.js';
import { KB_PATHSPECS, commitKnowledgeTrees, gitRun } from './_kb-commit.js';
import { requireUsableGit } from '../../../repo/git-workspace.js';

const DEFAULT_KB_COMMIT_MESSAGE = 'docs: update knowledge base from workflow';

interface KbCommitDetect {
  hasGit: boolean;
  workspacePath: string;
  /** Repo-relative KB/learning paths with pending changes (from git status). */
  dirtyFiles: string[];
  statusSummary: string;
  /** Stable `.haive/` path the form's diff viewer fetches — the same viewer the
   *  learning gate uses, so the files can be read AND edited here before they are
   *  committed. null when there is no usable git repo or the build failed. */
  knowledgeDiffArtifactPath: string | null;
}

interface KbCommitApply {
  committed: boolean;
  commitSha: string | null;
  message: string;
}

/** Resolve the worktree the learning phase wrote into (mirrors 10-gate-3-commit /
 *  11-phase-8-learning): the worktree path from 01-worktree-setup, falling back to
 *  the repo workspace when there is no worktree row. */
async function resolveWorkspace(ctx: StepContext): Promise<string> {
  const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
  const out = prev?.output as { worktreePath?: string } | null;
  return out?.worktreePath ?? ctx.workspacePath;
}

/** True when the learning phase (11) wrote KB/learning FILES to disk that must be
 *  committed: learnings written, or a LOCAL investigation file. A promoted
 *  "global-kb:<id>" investigation writes no file, and a skipped/empty capture
 *  writes nothing — both make this false. Exported for the unit test; mirrors
 *  03c's hasRequirements. */
export function hasKbToCommit(
  out: { written?: string[]; investigationWritten?: string | null } | null,
): boolean {
  if (!out) return false;
  const wroteLearnings = Array.isArray(out.written) && out.written.length > 0;
  const inv = out.investigationWritten;
  const wroteLocalInvestigation = typeof inv === 'string' && !inv.startsWith('global-kb:');
  return wroteLearnings || wroteLocalInvestigation;
}

export const kbCommitStep: StepDefinition<KbCommitDetect, KbCommitApply> = {
  metadata: {
    id: '11b-kb-commit',
    workflowType: 'workflow',
    index: 11.5,
    title: 'Commit knowledge base',
    description:
      'Commits the knowledge-base and learning files written by the learning phase onto the feature branch so they push, merge, and travel to a clone. Under auto-continue it commits automatically; otherwise it parks for confirmation.',
    requiresCli: false,
    // Local-only / nothing-to-commit cases can be skipped without blocking the
    // task. Keep in sync with SKIPPABLE_STEP_IDS in @haive/shared.
    allowSkip: true,
    // Honor the description's "commits automatically under auto-continue": submit the
    // form's defaults (commit ticked + default message) instead of parking. Manual gates.
    autoSubmitDefaults: true,
  },

  // Only run when the learning phase actually wrote KB/learning files to disk in
  // the worktree (writeFiles kept, or a LOCAL investigation written). A purely
  // promoted-to-global investigation writes no file ("global-kb:<id>") and a
  // skipped/empty learning capture writes nothing — both auto-skip this gate.
  async shouldRun(ctx: StepContext): Promise<boolean> {
    const learning = await loadPreviousStepOutput(ctx.db, ctx.taskId, '11-phase-8-learning');
    return hasKbToCommit(
      (learning?.output as { written?: string[]; investigationWritten?: string | null } | null) ??
        null,
    );
  },

  async detect(ctx: StepContext): Promise<KbCommitDetect> {
    const workspacePath = await resolveWorkspace(ctx);
    // Throws on a corrupt repo rather than reporting "(no git)" and skipping the
    // KB commit — a broken gitfile is not an absent one.
    if (!(await requireUsableGit(workspacePath))) {
      return {
        hasGit: false,
        workspacePath,
        dirtyFiles: [],
        statusSummary: '(no git)',
        knowledgeDiffArtifactPath: null,
      };
    }
    // Porcelain over the KB pathspecs surfaces both modified (` M`) and untracked
    // (`??`) files — a first-time investigation file is untracked, so `git diff`
    // would miss it. The 3-char status prefix is stripped for the display path.
    const status = await gitRun(workspacePath, ['status', '--porcelain', '--', ...KB_PATHSPECS]);
    if (status.code !== 0) {
      throw new Error(`git status failed in ${workspacePath}: ${status.stderr || status.stdout}`);
    }
    const lines = status.stdout
      .split('\n')
      .map((l) => l.replace(/\r$/, ''))
      .filter((l) => l.trim().length > 0);
    const dirtyFiles = lines.map((l) => l.slice(3).trim()).filter(Boolean);
    // Over BOTH knowledge trees: unlike the learning gate, by this step the
    // learnings are ordinary written files. Best-effort — losing the diff costs
    // the gate its review surface, not its commit.
    let knowledgeDiffArtifactPath: string | null = null;
    try {
      knowledgeDiffArtifactPath = await buildKnowledgeDiffArtifact(workspacePath, gitRun, [], {
        pathspecs: KB_PATHSPECS,
        artifactName: KB_COMMIT_DIFF_ARTIFACT_NAME,
      });
    } catch (err) {
      ctx.logger.warn({ err }, 'failed to build kb-commit knowledge diff artifact');
    }
    return {
      hasGit: true,
      workspacePath,
      dirtyFiles,
      statusSummary: lines.join('\n') || 'No knowledge-base changes pending.',
      knowledgeDiffArtifactPath,
    };
  },

  form(_ctx, detected): FormSchema {
    return {
      title: 'Commit knowledge base',
      description: [
        `Workspace: ${detected.workspacePath}`,
        `Knowledge-base / learning files changed: ${detected.dirtyFiles.length}`,
        detected.knowledgeDiffArtifactPath
          ? 'Review the changes below — they can be edited inline before they are committed.'
          : '',
        '',
        detected.statusSummary,
      ]
        .filter(Boolean)
        .join('\n'),
      fields: [
        {
          type: 'checkbox',
          id: 'commit',
          label: 'Commit knowledge-base updates to the feature branch',
          // Default-true (when there is something to commit) means the existing
          // auto-continue mechanism auto-submits a commit; manual mode parks here.
          default: detected.hasGit && detected.dirtyFiles.length > 0,
        },
        {
          type: 'textarea',
          id: 'commitMessage',
          label: 'Commit message',
          rows: 3,
          default: DEFAULT_KB_COMMIT_MESSAGE,
        },
      ],
      submitLabel: 'Commit',
    };
  },

  async apply(ctx, args): Promise<KbCommitApply> {
    const values = args.formValues as { commit?: boolean; commitMessage?: string };
    if (!values.commit) {
      return { committed: false, commitSha: null, message: 'kb commit skipped' };
    }
    if (!args.detected.hasGit) {
      return { committed: false, commitSha: null, message: 'no git repo' };
    }
    const result = await commitKnowledgeTrees({
      workspace: args.detected.workspacePath,
      message: (values.commitMessage ?? '').trim() || DEFAULT_KB_COMMIT_MESSAGE,
      db: ctx.db,
      userId: ctx.userId,
      taskId: ctx.taskId,
    });
    if (result.committed) {
      ctx.logger.info(
        { commitSha: result.commitSha, message: result.message },
        'knowledge-base commit finalised',
      );
    }
    return result;
  },
};
