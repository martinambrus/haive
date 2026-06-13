import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { desc, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput, pathExists } from '../onboarding/_helpers.js';
import { getDecryptedCredentials } from '../../../repo/credentials.js';

const exec = promisify(execFile);

const MANUAL_CREDENTIAL_VALUE = '';

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
  recentCommits: string;
  repositoryId: string | null;
  boundCredentialId: string | null;
  credentials: CredentialOption[];
}

interface PushGateApply {
  pushed: boolean;
  remote: string | null;
  branch: string | null;
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

/** Replace every occurrence of the secret in command output before it is
 *  logged or surfaced to the user. Defensive: git masks credential-helper
 *  passwords in most errors, but a misconfigured remote can echo them. */
function scrubSecret(text: string, secret: string | null): string {
  if (!secret) return text;
  return text.split(secret).join('***');
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
  },

  async detect(ctx: StepContext): Promise<PushGateDetect> {
    const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
    const worktreeOutput = prev?.output as { worktreePath?: string } | null;
    const workspacePath = worktreeOutput?.worktreePath ?? ctx.workspacePath;

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

    const hasGit = await pathExists(path.join(workspacePath, '.git'));
    if (!hasGit) {
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
      };
    }

    const branchRes = await gitRun(workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = branchRes.code === 0 ? branchRes.stdout.trim() : null;

    const remotesRes = await gitRun(workspacePath, ['remote']);
    const hasOrigin =
      remotesRes.code === 0 &&
      remotesRes.stdout
        .split('\n')
        .map((l) => l.trim())
        .includes('origin');

    let originUrl: string | null = null;
    if (hasOrigin) {
      const urlRes = await gitRun(workspacePath, ['remote', 'get-url', 'origin']);
      originUrl = urlRes.code === 0 ? urlRes.stdout.trim() : null;
    }

    const logRes = await gitRun(workspacePath, ['log', '--oneline', '-10']);
    const recentCommits =
      logRes.code === 0 && logRes.stdout.trim().length > 0
        ? logRes.stdout.trim().slice(0, 3000)
        : 'No commits found on this branch.';

    return {
      hasGit: true,
      workspacePath,
      branch,
      hasOrigin,
      originUrl,
      recentCommits,
      repositoryId,
      boundCredentialId: repo?.credentialsSecretId ?? null,
      credentials,
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

    if (detected.hasOrigin) {
      return {
        title: 'Gate 4: Push',
        description: descriptionLines.join('\n'),
        fields: [
          {
            type: 'checkbox',
            id: 'push',
            label: `Push ${detected.branch ?? 'HEAD'} to origin (${detected.originUrl ?? 'origin'})`,
            default: false,
          },
          {
            type: 'select',
            id: 'credentialId',
            label: 'Credential to push with',
            description:
              'Used only for this push; the token is never written to git config. Choose "manually" for SSH or public remotes.',
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
        {
          type: 'text',
          id: 'remoteUrl',
          label: 'Origin remote URL',
          placeholder: 'https://github.com/owner/repo.git',
          required: true,
        },
        {
          type: 'select',
          id: 'credentialId',
          label: 'Credential to push with',
          description:
            'Used only for this push; the token is never written to git config. Choose "manually" for SSH or public remotes.',
          options: credentialOptions,
          default: defaultCredential,
        },
        {
          type: 'checkbox',
          id: 'push',
          label: 'Add origin and push',
          default: false,
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
    if (!detected.hasOrigin) {
      const remoteUrl = (values.remoteUrl ?? '').trim();
      if (!remoteUrl) {
        throw new Error('origin remote URL is required to push');
      }
      const add = await gitRun(workspace, ['remote', 'add', 'origin', remoteUrl]);
      if (add.code !== 0 && !/remote origin already exists/i.test(add.stderr)) {
        throw new Error(`git remote add origin failed: ${add.stderr || add.stdout}`);
      }
      if (/remote origin already exists/i.test(add.stderr)) {
        await gitRun(workspace, ['remote', 'set-url', 'origin', remoteUrl]);
      }
      // Persist the remote (and the chosen credential) onto the repo row so
      // future pushes/clones are pre-wired. Plain runtime write; idempotent.
      if (detected.repositoryId) {
        const patch: { remoteUrl: string; credentialsSecretId?: string; updatedAt: Date } = {
          remoteUrl,
          updatedAt: new Date(),
        };
        if (values.credentialId) patch.credentialsSecretId = values.credentialId;
        await ctx.db
          .update(schema.repositories)
          .set(patch)
          .where(eq(schema.repositories.id, detected.repositoryId));
      }
    }

    const setUpstream = detected.hasOrigin ? values.setUpstream !== false : true;
    const pushArgs: string[] = [];
    const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
    let secret: string | null = null;

    if (values.credentialId) {
      const creds = await getDecryptedCredentials(ctx.db, values.credentialId, ctx.userId);
      secret = creds.secret;
      // Inline, one-shot credential helper. The token rides in env (not argv,
      // not .git/config), so it never persists and isn't visible via `ps`.
      // Leading empty `credential.helper=` clears any inherited global helper.
      env.GIT_HAIVE_USER = creds.username;
      env.GIT_HAIVE_PASS = creds.secret;
      pushArgs.push(
        '-c',
        'credential.helper=',
        '-c',
        `credential.helper=!f() { test "$1" = get && printf 'username=%s\\npassword=%s\\n' "$GIT_HAIVE_USER" "$GIT_HAIVE_PASS"; }; f`,
      );
    }

    pushArgs.push('push');
    if (setUpstream) pushArgs.push('-u');
    pushArgs.push('origin', branch);

    const res = await gitRun(workspace, pushArgs, env);
    if (res.code !== 0) {
      const stderr = scrubSecret(res.stderr || res.stdout, secret);
      throw new Error(`git push failed: ${stderr}`);
    }
    ctx.logger.info({ branch, remote: 'origin' }, 'workflow push finalised');
    return { pushed: true, remote: 'origin', branch, message: `pushed ${branch} to origin` };
  },
};
