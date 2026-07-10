import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput, pathExists } from '../onboarding/_helpers.js';
import { resolveGitEnv } from '../../../secrets/user-git-identity.js';
import { requireUsableGit } from '../../../repo/git-workspace.js';

const exec = promisify(execFile);

const FALLBACK_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Haive',
  GIT_AUTHOR_EMAIL: 'worker@haive.local',
  GIT_COMMITTER_NAME: 'Haive',
  GIT_COMMITTER_EMAIL: 'worker@haive.local',
};

// Knowledge-base + learnings trees written by the learning phase (11). Both carry
// durable knowledge that must travel ON the feature branch: committed here →
// pushed (11a) → merged (12) → and so reaching a fresh clone (the file fallback
// when another instance has no shared RAG/DB). Pathspecs are repo-relative.
const KB_PATHSPECS = ['.claude/knowledge_base', '.claude/learnings'] as const;

const DEFAULT_KB_COMMIT_MESSAGE = 'docs: update knowledge base from workflow';

interface KbCommitDetect {
  hasGit: boolean;
  workspacePath: string;
  /** Repo-relative KB/learning paths with pending changes (from git status). */
  dirtyFiles: string[];
  statusSummary: string;
}

interface KbCommitApply {
  committed: boolean;
  commitSha: string | null;
  message: string;
}

async function gitRun(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const opts = env ? { cwd, env: { ...process.env, ...env } } : { cwd };
    const { stdout, stderr } = await exec('git', args, opts);
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
      return { hasGit: false, workspacePath, dirtyFiles: [], statusSummary: '(no git)' };
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
    return {
      hasGit: true,
      workspacePath,
      dirtyFiles,
      statusSummary: lines.join('\n') || 'No knowledge-base changes pending.',
    };
  },

  form(_ctx, detected): FormSchema {
    return {
      title: 'Commit knowledge base',
      description: [
        `Workspace: ${detected.workspacePath}`,
        `Knowledge-base / learning files changed: ${detected.dirtyFiles.length}`,
        '',
        detected.statusSummary,
      ].join('\n'),
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
    const workspace = args.detected.workspacePath;
    // `git add` fatals on a pathspec that matches nothing (unlike `git status`), so
    // stage only the KB trees that actually exist — a run may write knowledge_base
    // without learnings, or vice versa.
    const present: string[] = [];
    for (const spec of KB_PATHSPECS) {
      if (await pathExists(path.join(workspace, spec))) present.push(spec);
    }
    if (present.length === 0) {
      return { committed: false, commitSha: null, message: 'nothing to commit' };
    }
    const add = await gitRun(workspace, ['add', '--', ...present]);
    if (add.code !== 0) {
      throw new Error(`git add failed: ${add.stderr || add.stdout}`);
    }
    const message = (values.commitMessage ?? '').trim() || DEFAULT_KB_COMMIT_MESSAGE;
    const userEnv = await resolveGitEnv(ctx.db, { userId: ctx.userId, taskId: ctx.taskId });
    const commitEnv = Object.keys(userEnv).length > 0 ? userEnv : FALLBACK_GIT_IDENTITY;
    const commit = await gitRun(workspace, ['commit', '-m', message], commitEnv);
    if (commit.code !== 0) {
      const stderr = commit.stderr || commit.stdout;
      // KB files already clean (e.g. committed by an earlier retry) — not an error.
      if (/nothing to commit/i.test(stderr)) {
        return { committed: false, commitSha: null, message: 'nothing to commit' };
      }
      throw new Error(`git commit failed: ${stderr}`);
    }
    const sha = await gitRun(workspace, ['rev-parse', 'HEAD']);
    const commitSha = sha.code === 0 ? sha.stdout.trim() : null;
    ctx.logger.info({ commitSha, message }, 'knowledge-base commit finalised');
    return { committed: true, commitSha, message };
  },
};
