import { and, desc, eq, sql } from 'drizzle-orm';
import { REPOSITORY_TASKS_LOCK_TIMEOUT_MS, schema } from '@haive/database';
import { insertAuditEvent, logAuditEvent, type AuditEvent } from '../../../audit.js';
import type { FormSchema } from '@haive/shared';
import { gitRemoteUrlSchema, parseScpLikeGitUrl, redactGitUrl } from '@haive/shared/schemas';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import {
  OriginUrlError,
  buildCredentialHelper,
  taskRemoteUrl,
  ensureOrigin,
  getOriginUrl,
  gitRun,
  pushBranch,
} from '../../../repo/git-push.js';
import { gitGaveNoAnswer } from '../../../repo/git-exec.js';
import { requireUsableGit } from '../../../repo/git-workspace.js';
import { putBackProjections, warnStep } from '../../../project-state/branch-revert.js';

const MANUAL_CREDENTIAL_VALUE = '';

/** Establish the approved remote while the repository row and its audit move together. */
async function persistPushOrigin(
  ctx: StepContext,
  repositoryId: string,
  workspace: string,
  remoteUrl: string,
  credentialId: string | undefined,
  addOrigin: boolean,
  detectedOriginUrl: string | null,
): Promise<void> {
  // The common, already-bound push needs no repository write or row lock.
  const readStored = (db: Pick<StepContext['db'], 'select'>) =>
    db
      .select({
        remoteUrl: schema.repositories.remoteUrl,
        credentialsSecretId: schema.repositories.credentialsSecretId,
      })
      .from(schema.repositories)
      .where(
        and(eq(schema.repositories.id, repositoryId), eq(schema.repositories.userId, ctx.userId)),
      );
  const [initial] = await readStored(ctx.db);
  if (!initial) throw new Error('Repository no longer exists');
  if (!addOrigin && initial.remoteUrl !== null) return;

  let addedOrigin = false;
  let restoreFailure: Error | undefined;
  let event: AuditEvent | undefined;
  let callbackSettled: Promise<void> | undefined;
  const restore = async (err: unknown): Promise<never> => {
    if (restoreFailure) throw restoreFailure;
    if (addedOrigin) {
      addedOrigin = false;
      try {
        const removed = await boundedRemoteGit((signal) =>
          gitRun(workspace, ['remote', 'remove', 'origin'], undefined, { signal }),
        );
        // Exit 2: an interrupted add left no origin to remove.
        if (removed.code !== 0 && removed.code !== 2) throw new Error('Origin removal failed');
      } catch (restoreError) {
        restoreFailure = new AggregateError(
          [restoreError],
          'Remote update failed and the added origin could not be removed',
          { cause: err },
        );
        throw restoreFailure;
      }
    }
    throw err;
  };
  try {
    await ctx.db.transaction(async (tx) => {
      let settle!: () => void;
      callbackSettled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      try {
        await tx.execute(
          sql.raw(`SET LOCAL lock_timeout = '${REPOSITORY_TASKS_LOCK_TIMEOUT_MS}ms'`),
        );
        const [stored] = await readStored(tx).for('no key update');
        await tx.execute(sql.raw('SET LOCAL lock_timeout = DEFAULT'));
        if (!stored) throw new Error('Repository no longer exists');
        // An existing binding makes this a one-off push. Only an empty row needs Retry repair.
        if (!addOrigin && stored.remoteUrl !== null) return;
        let approvedUrl = remoteUrl;
        if (!addOrigin) {
          const current = await boundedRemoteGit((signal) => getOriginUrl(workspace, { signal }));
          if (current === null)
            throw new Error('Origin disappeared while this push was waiting; retry');
          const parsed = gitRemoteUrlSchema.safeParse(current);
          if (!parsed.success) throw new Error('Origin is not a valid Git remote');
          const detected = gitRemoteUrlSchema.safeParse(detectedOriginUrl);
          if (!detected.success || parsed.data !== detected.data)
            throw new Error('Origin changed since the form was shown; retry this step');
          approvedUrl = detected.data;
        }
        if (credentialId) await buildCredentialHelper(tx, credentialId, ctx.userId, approvedUrl);
        const patch = {
          remoteUrl: approvedUrl,
          ...(credentialId ? { credentialsSecretId: credentialId } : {}),
        };
        const fields = (Object.keys(patch) as (keyof typeof patch)[]).filter(
          (field) => patch[field] !== stored[field],
        );
        if (fields.length) {
          event = {
            actorUserId: ctx.userId,
            action: 'repository.remote.update',
            targetType: 'repository',
            targetId: repositoryId,
            metadata: {
              source: 'gate4_push',
              actorKind: 'task_user',
              fields,
              host: parseScpLikeGitUrl(approvedUrl)?.host ?? new URL(approvedUrl).hostname,
              credentialsChanged:
                patch.credentialsSecretId !== undefined &&
                patch.credentialsSecretId !== stored.credentialsSecretId,
              branchChanged: false,
            },
          };
          await insertAuditEvent(tx, event);
        }
        try {
          if (addOrigin)
            await boundedRemoteGit((signal) =>
              ensureOrigin(workspace, approvedUrl, {
                addOnly: true,
                signal,
                onAdded: () => {
                  addedOrigin = true;
                },
              }),
            );
          if (fields.length)
            await tx
              .update(schema.repositories)
              .set({ ...patch, updatedAt: new Date() })
              .where(eq(schema.repositories.id, repositoryId));
        } catch (err) {
          // Restore before a queued relink can acquire the repository row.
          await restore(err);
        }
      } finally {
        settle();
      }
    });
  } catch (err) {
    // A connection can reject the transaction while its callback is still doing git work.
    await callbackSettled;
    await restore(err);
  }
  if (event) logAuditEvent(event);
}

/** A remote edit must release the row promptly, including a child that ignores SIGTERM. */
async function boundedRemoteGit<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 10_000);
  try {
    const result = await run(controller.signal);
    if (controller.signal.aborted) throw new Error('Git remote operation timed out');
    return result;
  } finally {
    clearTimeout(deadline);
  }
}

interface CredentialOption {
  id: string;
  label: string;
  host: string;
}

interface PushGateDetect {
  hasGit: boolean;
  workspacePath: string;
  branch: string | null;
  hasOrigin: boolean;
  originUrl: string | null;
  originError?: string | null;
  recentCommits: string;
  repositoryId: string | null;
  boundCredentialId: string | null;
  credentials: CredentialOption[];
  /** The branch 01 forked the worktree from; absent where 01 did not run or the output predates it. */
  baseBranch?: string | null;
}

interface PushGateApply {
  pushed: boolean;
  remote: string | null;
  branch: string | null;
  message: string;
}

export const gate4PushStep: StepDefinition<PushGateDetect, PushGateApply> = {
  metadata: {
    id: '11a-gate-4-push',
    workflowType: 'workflow',
    index: 12,
    title: 'Gate 4: Push',
    description:
      'Presents the branch and pending commits and offers to push to origin once the user confirms. Nothing is pushed automatically. If the repo has no origin yet, lets the user add one and pick a credential.',
    requiresCli: false,
    // Local-only projects have no remote to push to; allow the user to Skip
    // this gate so the task can still finish. Keep in sync with
    // SKIPPABLE_STEP_IDS in @haive/shared.
    allowSkip: true,
  },

  async detect(ctx: StepContext): Promise<PushGateDetect> {
    const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
    const worktreeOutput = prev?.output as { worktreePath?: string; baseBranch?: string } | null;
    const workspacePath = worktreeOutput?.worktreePath ?? ctx.workspacePath;
    const baseBranch = worktreeOutput?.baseBranch ?? null;

    const task = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: { repositoryId: true },
    });
    const repositoryId = task?.repositoryId ?? null;
    const repo = repositoryId
      ? await ctx.db.query.repositories.findFirst({
          where: eq(schema.repositories.id, repositoryId),
          columns: { credentialsSecretId: true },
        })
      : null;

    const credentialRows = await ctx.db.query.repoCredentials.findMany({
      where: eq(schema.repoCredentials.userId, ctx.userId),
      columns: { id: true, label: true, host: true },
      orderBy: [desc(schema.repoCredentials.createdAt)],
    });
    const credentials: CredentialOption[] = credentialRows.map((r) => ({
      id: r.id,
      label: r.label,
      host: r.host,
    }));

    // Throws on a corrupt repo: silently offering "(no git)" would hide the branch
    // the user asked to push.
    if (!(await requireUsableGit(workspacePath))) {
      return {
        hasGit: false,
        workspacePath,
        branch: null,
        hasOrigin: false,
        originUrl: null,
        recentCommits: '(no git)',
        repositoryId,
        boundCredentialId: repo?.credentialsSecretId ?? null,
        credentials,
        baseBranch,
      };
    }

    const branchRes = await gitRun(workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const unborn =
      branchRes.code !== 0 &&
      !gitGaveNoAnswer(branchRes) &&
      (await gitRun(workspacePath, ['rev-parse', '-q', '--verify', 'HEAD'])).code === 1;
    if (branchRes.code !== 0 && !unborn) {
      throw new Error(
        `could not read the checkout's current branch: ${(branchRes.stderr || branchRes.stdout).trim()}`,
      );
    }
    const branch = unborn ? null : branchRes.stdout.trim();

    let originUrl: string | null = null;
    let originError: string | null = null;
    try {
      originUrl = await getOriginUrl(workspacePath);
    } catch (err) {
      if (!(err instanceof OriginUrlError)) throw err;
      originError = err.message;
    }
    const hasOrigin = originUrl !== null;

    const logRes = unborn ? null : await gitRun(workspacePath, ['log', '--oneline', '-10']);
    if (logRes && logRes.code !== 0) {
      throw new Error(
        `git log failed in ${workspacePath}: ${(logRes.stderr || logRes.stdout).trim()}`,
      );
    }
    const recentCommits =
      logRes?.stdout.trim().slice(0, 3000) || 'No commits found on this branch.';

    return {
      hasGit: true,
      workspacePath,
      branch,
      hasOrigin,
      originUrl,
      originError,
      recentCommits,
      repositoryId,
      boundCredentialId: repo?.credentialsSecretId ?? null,
      credentials,
      baseBranch,
    };
  },

  form(_ctx, detected): FormSchema {
    const credentialOptions = [
      ...detected.credentials.map((c) => ({ value: c.id, label: `${c.label} (${c.host})` })),
      { value: MANUAL_CREDENTIAL_VALUE, label: 'Authenticate manually (no stored credential)' },
    ];
    const defaultCredential =
      detected.boundCredentialId &&
      detected.credentials.some((c) => c.id === detected.boundCredentialId)
        ? detected.boundCredentialId
        : MANUAL_CREDENTIAL_VALUE;

    const descriptionLines = [
      `Workspace: ${detected.workspacePath}`,
      `Branch: ${detected.branch ?? 'unknown'}`,
      '',
      'Recent commits:',
      detected.recentCommits,
    ];

    if (!detected.hasGit) {
      return {
        title: 'Gate 4: Push',
        description: 'No git repository detected at the workspace. Nothing to push.',
        fields: [
          {
            type: 'checkbox',
            id: 'push',
            label: 'Push to origin',
            default: false,
          },
        ],
        submitLabel: 'Finalise',
      };
    }

    if (detected.originError) {
      return {
        title: 'Gate 4: Push',
        description: descriptionLines.join('\n'),
        fields: [
          {
            type: 'note',
            id: 'originError',
            label: 'Push unavailable',
            body: detected.originError,
            variant: 'warning',
          },
        ],
        submitLabel: 'Finalise',
      };
    }

    if (detected.hasOrigin) {
      return {
        title: 'Gate 4: Push',
        description: descriptionLines.join('\n'),
        fields: [
          {
            type: 'checkbox',
            id: 'push',
            label: `Push ${detected.branch ?? 'HEAD'} to origin (${detected.originUrl ? redactGitUrl(detected.originUrl) : 'origin'})`,
            default: false,
          },
          {
            type: 'select',
            id: 'credentialId',
            label: 'Credential to push with',
            description:
              'Used for this push. If the repository has no remote saved yet, this push also saves its address and this credential on the repository. The token is never written to git config. Choose "manually" for SSH or public remotes.',
            options: credentialOptions,
            default: defaultCredential,
          },
          {
            type: 'checkbox',
            id: 'setUpstream',
            label: 'Set upstream (-u) so future pushes default to origin',
            default: true,
          },
        ],
        submitLabel: 'Push',
      };
    }

    return {
      title: 'Gate 4: Push',
      description: [
        ...descriptionLines,
        '',
        'No origin remote is configured. Add one to push this branch.',
      ].join('\n'),
      fields: [
        // The checkbox leads: everything below it only applies once the user opts in,
        // and a field revealed by a control BELOW it reads backwards.
        {
          type: 'checkbox',
          id: 'push',
          label: 'Add origin and push',
          default: false,
        },
        {
          type: 'text',
          id: 'remoteUrl',
          label: 'Origin remote URL',
          placeholder: 'https://github.com/owner/repo.git',
          required: true,
          // Required only once the user asks to push. Without this gate the form
          // demanded a URL even to DECLINE the push — an input apply() explicitly
          // handles (`if (!values.push) ... 'push skipped'`) — so a repo with no origin
          // had no valid submission and the step failed the whole task.
          visibleWhen: { field: 'push', equals: true },
        },
        {
          type: 'select',
          id: 'credentialId',
          label: 'Credential to push with',
          description:
            'Used for this push. This push also saves the address above and this credential as the repository\'s remote and credential, replacing any saved ones, so later tasks use them too. The token is never written to git config. Choose "manually" for SSH or public remotes.',
          options: credentialOptions,
          default: defaultCredential,
          visibleWhen: { field: 'push', equals: true },
        },
      ],
      submitLabel: 'Add origin & push',
    };
  },

  async apply(ctx, args): Promise<PushGateApply> {
    const values = args.formValues as {
      push?: boolean;
      credentialId?: string;
      setUpstream?: boolean;
      remoteUrl?: string;
    };
    const detected = args.detected;

    if (detected.originError) {
      return {
        pushed: false,
        remote: null,
        branch: detected.branch,
        message: detected.originError,
      };
    }
    if (!values.push) {
      return { pushed: false, remote: null, branch: detected.branch, message: 'push skipped' };
    }
    if (!detected.hasGit) {
      return { pushed: false, remote: null, branch: null, message: 'no git repo' };
    }
    const branch = detected.branch;
    if (!branch) {
      throw new Error('could not resolve current branch to push');
    }
    const workspace = detected.workspacePath;

    // Establish origin. For the no-origin path the user supplies a clean URL
    // (no embedded token); we persist that, never the credentialed URL.
    let originUrl: string | null;
    try {
      originUrl = await boundedRemoteGit((signal) => getOriginUrl(workspace, { signal }));
    } catch (err) {
      if (!(err instanceof OriginUrlError)) throw err;
      return { pushed: false, remote: null, branch, message: err.message };
    }
    const hasOrigin = originUrl !== null;
    let remoteUrl = originUrl;
    if (!hasOrigin) {
      const suppliedUrl = (values.remoteUrl ?? '').trim();
      if (!suppliedUrl) {
        throw new Error('origin remote URL is required to push');
      }
      const parsed = gitRemoteUrlSchema.safeParse(suppliedUrl);
      if (!parsed.success) throw new Error(parsed.error.issues[0]!.message);
      remoteUrl = parsed.data;
    }
    if (detected.repositoryId) {
      await persistPushOrigin(
        ctx,
        detected.repositoryId,
        workspace,
        remoteUrl!,
        values.credentialId,
        !hasOrigin,
        detected.originUrl,
      );
    } else if (!hasOrigin) {
      if (values.credentialId)
        await buildCredentialHelper(ctx.db, values.credentialId, ctx.userId, remoteUrl);
      await ensureOrigin(workspace, remoteUrl!);
    }

    if (detected.baseBranch) {
      const target = detected.baseBranch;
      await warnStep(ctx, await putBackProjections({ ctx, worktree: workspace, branch, target }));
    }

    const setUpstream = hasOrigin ? values.setUpstream !== false : true;
    try {
      await pushBranch({
        cwd: workspace,
        branch,
        setUpstream,
        credentialId: values.credentialId || undefined,
        remoteUrl: values.credentialId ? await taskRemoteUrl(ctx) : null,
        db: ctx.db,
        userId: ctx.userId,
      });
    } catch (err) {
      if (!(err instanceof OriginUrlError)) throw err;
      return { pushed: false, remote: null, branch, message: err.message };
    }
    ctx.logger.info({ branch, remote: 'origin' }, 'workflow push finalised');
    return { pushed: true, remote: 'origin', branch, message: `pushed ${branch} to origin` };
  },
};
