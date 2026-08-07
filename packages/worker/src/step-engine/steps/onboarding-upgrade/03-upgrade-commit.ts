import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { CliProviderName, FormField, FormSchema } from '@haive/shared';
import { getCliProviderMetadata } from '@haive/shared';
import type { Database } from '@haive/database';
import type { StepDefinition } from '../../step-definition.js';
import { resolveGitEnv } from '../../../secrets/user-git-identity.js';
import { initGitWorkspace } from '../../../repo/git-init.js';
import { gitWorkspaceStatus, requireUsableGit } from '../../../repo/git-workspace.js';
import { pathExists } from '../onboarding/_helpers.js';

const execFileAsync = promisify(execFile);

const DEFAULT_COMMIT_MESSAGE = [
  'chore: apply Haive onboarding upgrade',
  '',
  'Applies selected template updates from the onboarding-upgrade workflow.',
].join('\n');

/** Default for the no-git case, where the commit is also the repository's first and
 *  therefore holds the pre-existing project files as well as the upgraded ones. */
const INIT_COMMIT_MESSAGE = [
  'chore: initial commit with Haive onboarding upgrade',
  '',
  'Initializes the repository with the existing project files plus the selected',
  'template updates from the onboarding-upgrade workflow.',
].join('\n');

const BASE_STAGE_PATHS = [
  '.gitignore',
  '.claude/agents/',
  '.claude/skills/',
  '.claude/knowledge_base/',
  '.claude/workflow/',
  '.claude/mcp_settings.json',
  '.claude/workflow-checkpoint.json',
  '.claude/project-config.yaml',
  '.haive/install.json',
];

async function resolveStagePaths(db: Database, userId: string): Promise<string[]> {
  const providerRows = await db.query.cliProviders.findMany({
    where: eq(schema.cliProviders.userId, userId),
    columns: { name: true, enabled: true },
  });
  const extra = new Set<string>();
  for (const row of providerRows) {
    if (!row.enabled) continue;
    const meta = getCliProviderMetadata(row.name as CliProviderName);
    if (meta.projectAgentsDir) extra.add(`${meta.projectAgentsDir}/`);
    if (meta.projectSkillsDir) extra.add(`${meta.projectSkillsDir}/`);
  }
  return [...BASE_STAGE_PATHS, ...Array.from(extra)];
}

/** Used only when neither the repo's bound credential nor the user carries an identity,
 *  preserving the bot attribution these commits have always had. */
const FALLBACK_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Haive Worker',
  GIT_AUTHOR_EMAIL: 'haive@local',
  GIT_COMMITTER_NAME: 'Haive Worker',
  GIT_COMMITTER_EMAIL: 'haive@local',
};

interface UpgradeCommitDetect {
  /** False when the repo carries no git history — an uploaded / in-place repo whose
   *  onboarding never committed. The commit path then runs `git init` first; without
   *  it `git add` dies with "fatal: not a git repository". */
  hasGit: boolean;
}

interface UpgradeCommitOutput {
  commitPerformed: boolean;
  commitSha: string | null;
  stagedPaths: string[];
  warnings: string[];
}

export const upgradeCommitStep: StepDefinition<UpgradeCommitDetect, UpgradeCommitOutput> = {
  metadata: {
    id: '03-upgrade-commit',
    workflowType: 'onboarding_upgrade',
    index: 3,
    title: 'Commit upgrade',
    description: 'Optionally stage and commit the applied upgrade changes.',
    requiresCli: false,
  },

  async shouldRun(ctx) {
    const { shouldRunUpgrade } = await import('./04-upgrade-rollback.js');
    return shouldRunUpgrade(ctx);
  },

  async detect(ctx): Promise<UpgradeCommitDetect> {
    // Classify rather than requireUsableGit: a corrupt `.git` must not fail this step
    // for a user who only wants to skip the commit and finish the upgrade. The commit
    // path re-checks and throws there.
    return { hasGit: (await gitWorkspaceStatus(ctx.repoPath)) === 'ok' };
  },

  form(_ctx, detected): FormSchema {
    const fields: FormField[] = [];

    // No git history (onboarding never committed): committing has to create the
    // repository first. The initial commit deliberately holds the WHOLE working tree,
    // not only the upgraded files — `git worktree add` checks out tracked files only,
    // so a first commit carrying just `.claude/` would hand every later workflow task
    // an empty project.
    if (!detected.hasGit) {
      fields.push(
        {
          type: 'note',
          id: 'noGitNote',
          label: 'No git repository',
          body:
            'This repository has no git history. Committing will run `git init` in the ' +
            'repository root and create an initial commit containing every current file ' +
            '(honouring .gitignore), not only the upgraded ones. Use the Terminal tab if ' +
            'you need a different setup (existing remote, custom .gitignore) and Retry afterwards.',
          variant: 'warning',
        },
        {
          type: 'checkbox',
          id: 'commit',
          label: 'Initialize git, then stage and commit',
          default: false,
        },
        {
          type: 'text',
          id: 'initBranch',
          label: 'Initial branch name',
          default: 'main',
          description: 'The branch `git init` creates.',
          visibleWhen: { field: 'commit', equals: true },
        },
      );
    } else {
      fields.push({
        type: 'checkbox',
        id: 'commit',
        label: 'Stage and commit upgrade changes',
        default: false,
      });
    }

    fields.push({
      type: 'textarea',
      id: 'commitMessage',
      label: 'Commit message',
      default: detected.hasGit ? DEFAULT_COMMIT_MESSAGE : INIT_COMMIT_MESSAGE,
      rows: 6,
    });

    return {
      title: 'Commit upgrade changes',
      description: 'Stage and commit the files the upgrade wrote, or skip and commit later.',
      fields,
      submitLabel: 'Finish upgrade',
    };
  },

  async apply(ctx, args): Promise<UpgradeCommitOutput> {
    const values = args.formValues;
    const warnings: string[] = [];
    let commitPerformed = false;
    let commitSha: string | null = null;
    const stagedPaths: string[] = [];

    if (values.commit !== true) {
      return { commitPerformed, commitSha, stagedPaths, warnings };
    }

    const stagePaths = await resolveStagePaths(ctx.db, ctx.userId);
    const existingPaths: string[] = [];
    for (const rel of stagePaths) {
      if (await pathExists(path.join(ctx.repoPath, rel))) existingPaths.push(rel);
    }
    if (existingPaths.length === 0) {
      warnings.push('no upgrade files found to stage');
      return { commitPerformed, commitSha, stagedPaths, warnings };
    }

    try {
      // A repo whose onboarding never committed carries no git history, so `git add`
      // dies with "fatal: not a git repository". Create the repo first, then stage the
      // WHOLE working tree: `git worktree add` checks out tracked files only, so a first
      // commit holding just the upgraded files would hand every later workflow task an
      // empty project. The .gitignore onboarding wrote is already on disk, so `add -A`
      // honours it. requireUsableGit rather than detect.hasGit: it throws on a `.git` git
      // refuses (corruption gets reported, never initialized over) and it re-reads state
      // detect may have missed, e.g. a Terminal-tab `git init`.
      let didInit = false;
      if (!(await requireUsableGit(ctx.repoPath))) {
        const initBranch =
          (typeof values.initBranch === 'string' ? values.initBranch : '').trim() || 'main';
        await initGitWorkspace(ctx.repoPath, initBranch);
        didInit = true;
        await execFileAsync('git', ['add', '-A'], { cwd: ctx.repoPath });
        ctx.logger.info({ initBranch }, 'upgrade-commit: initialized git repository');
      }
      // -f: .haive/install.json is under .haive/, which 01-worktree-setup excludes via
      // .git/info/exclude; a plain `git add` of an excluded path exits non-zero and
      // aborts the whole stage. Same fix as 12-post-onboarding.
      await execFileAsync('git', ['add', '-f', '--', ...existingPaths], { cwd: ctx.repoPath });
      const { stdout: stagedOut } = await execFileAsync(
        'git',
        ['diff', '--cached', '--name-only'],
        { cwd: ctx.repoPath },
      );
      const staged = stagedOut
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      stagedPaths.push(...staged);

      if (staged.length === 0) {
        warnings.push('no changes to commit (files already committed or identical)');
        return { commitPerformed, commitSha, stagedPaths, warnings };
      }

      const message =
        typeof values.commitMessage === 'string' && values.commitMessage.trim().length > 0
          ? values.commitMessage
          : didInit
            ? INIT_COMMIT_MESSAGE
            : DEFAULT_COMMIT_MESSAGE;
      const resolved = await resolveGitEnv(ctx.db, { userId: ctx.userId, taskId: ctx.taskId });
      const identity = Object.keys(resolved).length > 0 ? resolved : FALLBACK_GIT_IDENTITY;
      await execFileAsync('git', ['commit', '-m', message], {
        cwd: ctx.repoPath,
        env: { ...process.env, ...identity },
      });
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: ctx.repoPath });
      commitSha = stdout.trim();
      commitPerformed = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.logger.warn({ err }, 'upgrade-commit failed');
      // The user explicitly asked to commit; a git failure must be loud, not a silent
      // `done` with a buried warning. 02-upgrade-apply already wrote the files and the
      // artifact rows, so a Retry re-attempts the stage + commit safely. The two no-op
      // paths above (nothing to stage, nothing staged) stay warnings — they are
      // legitimate outcomes, not failures.
      throw new Error(`Staging or committing the upgrade changes failed: ${message}`);
    }

    return { commitPerformed, commitSha, stagedPaths, warnings };
  },
};
