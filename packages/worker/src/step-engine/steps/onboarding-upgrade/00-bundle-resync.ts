import { originGitRun, scrubSecret } from '../../../repo/git-push.js';
import { bundleGitAuth, type BundleGitBinding } from '../../../repo/bundle-git.js';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import type { BundleJobPayload, FormSchema, FormValues } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { gitRevParseHead, handleResyncGit } from '../../../repo/bundle-ingest.js';
import { gitRun } from '../../../repo/git-exec.js';
import { safeErrorMessage } from '@haive/shared/logger';

interface BundleResyncCandidate {
  bundleId: string;
  name: string;
  branch: string | null;
  storageRoot: string;
  lastSyncCommit: string | null;
  remoteCommit: string | null;
  hasUpstreamChange: boolean;
  fetchError: string | null;
}

export interface BundleResyncDetect {
  candidates: BundleResyncCandidate[];
}

export interface BundleResyncApply {
  resyncedBundleIds: string[];
  warnings: string[];
}

const FIELD_ID = 'bundlesToPull';

/** `git fetch` plus `git rev-parse origin/<branch>` returning the remote head.
 *  Pure read operation — does NOT update the local working tree, so on its
 *  own it cannot break a parser run. The actual pull happens in apply(). */
async function fetchRemoteHead(
  db: Database,
  bundle: BundleGitBinding,
  branch: string | null,
): Promise<string> {
  const cwd = bundle.storageRoot;
  const fetchArgs = ['fetch', '--quiet', 'origin'];
  if (branch) fetchArgs.push(branch);
  const auth = await bundleGitAuth(db, bundle);
  const fetched = await originGitRun(cwd, [...auth.argv, ...fetchArgs], auth.env);
  if (fetched.code !== 0) {
    const msg = scrubSecret(fetched.stderr, auth.secret).trim();
    throw new Error(`git fetch failed (exit ${fetched.noExit ?? fetched.code}): ${msg}`);
  }
  const ref = branch ? `origin/${branch}` : 'origin/HEAD';
  const rev = await gitRun(cwd, ['rev-parse', ref]);
  if (rev.code !== 0) {
    throw new Error(
      `git rev-parse ${ref} failed (exit ${rev.noExit ?? rev.code}): ${rev.stderr.trim()}`,
    );
  }
  return rev.stdout.trim();
}

async function loadGitBundles(ctx: StepContext): Promise<BundleResyncCandidate[]> {
  const taskRow = await ctx.db
    .select({ repositoryId: schema.tasks.repositoryId })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, ctx.taskId))
    .limit(1);
  const repositoryId = taskRow[0]?.repositoryId ?? null;
  if (!repositoryId) return [];

  const rows = await ctx.db
    .select({
      id: schema.customBundles.id,
      userId: schema.customBundles.userId,
      gitUrl: schema.customBundles.gitUrl,
      gitCredentialsId: schema.customBundles.gitCredentialsId,
      name: schema.customBundles.name,
      sourceType: schema.customBundles.sourceType,
      gitBranch: schema.customBundles.gitBranch,
      storageRoot: schema.customBundles.storageRoot,
      lastSyncCommit: schema.customBundles.lastSyncCommit,
      status: schema.customBundles.status,
    })
    .from(schema.customBundles)
    .where(eq(schema.customBundles.repositoryId, repositoryId));

  const out: BundleResyncCandidate[] = [];
  for (const row of rows) {
    if (row.sourceType !== 'git' || row.status !== 'active') continue;
    let remoteCommit: string | null = null;
    let fetchError: string | null = null;
    try {
      remoteCommit = await fetchRemoteHead(ctx.db, row, row.gitBranch ?? null);
    } catch (err) {
      fetchError = safeErrorMessage(err);
      ctx.logger.warn({ err, bundleId: row.id }, 'bundle upstream check failed');
    }
    let localHead: string | null = null;
    try {
      localHead = await gitRevParseHead(row.storageRoot);
    } catch (err) {
      fetchError ??= `could not read the local head: ${err instanceof Error ? err.message : String(err)}`;
    }
    const hasUpstreamChange =
      remoteCommit !== null && localHead !== null && remoteCommit !== localHead;
    out.push({
      bundleId: row.id,
      name: row.name,
      branch: row.gitBranch ?? null,
      storageRoot: row.storageRoot,
      lastSyncCommit: row.lastSyncCommit ?? localHead ?? null,
      remoteCommit,
      hasUpstreamChange,
      fetchError,
    });
  }
  return out;
}

function extractSelectedIds(values: FormValues): string[] {
  const raw = values[FIELD_ID];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/** Pre-upgrade step that refreshes git-sourced custom bundles before the
 *  upgrade-plan step builds the artifact diff. Without this, an upstream
 *  change in a bundle would never surface in the upgrade — the items
 *  persisted to `custom_bundle_items` would still reflect the prior commit. */
export const bundleResyncStep: StepDefinition<BundleResyncDetect, BundleResyncApply> = {
  metadata: {
    id: '00-bundle-resync',
    workflowType: 'onboarding_upgrade',
    index: 0,
    title: 'Resync custom bundles',
    description:
      'Checks each git-sourced custom bundle for upstream changes and (when accepted) pulls + re-parses to refresh the catalog before the upgrade plan runs.',
    requiresCli: false,
  },

  async shouldRun(ctx) {
    const { shouldRunUpgrade } = await import('./04-upgrade-rollback.js');
    return shouldRunUpgrade(ctx);
  },

  async detect(ctx): Promise<BundleResyncDetect> {
    const candidates = await loadGitBundles(ctx);
    return { candidates };
  },

  form(_ctx, detected): FormSchema | null {
    const drifted = detected.candidates.filter((c) => c.hasUpstreamChange);
    const unchecked = detected.candidates.filter((c) => c.fetchError);
    if (drifted.length === 0 && unchecked.length === 0) {
      return null;
    }
    const fields: FormSchema['fields'] = [];
    if (drifted.length > 0) {
      fields.push({
        type: 'multi-select',
        id: FIELD_ID,
        label: 'Pull these bundles',
        options: drifted.map((c) => ({
          value: c.bundleId,
          label: `${c.name}${c.branch ? ` @ ${c.branch}` : ''} — ${c.lastSyncCommit?.slice(0, 7) ?? '(unknown)'} → ${c.remoteCommit?.slice(0, 7) ?? '(unknown)'}`,
        })),
        defaults: drifted.map((c) => c.bundleId),
      });
    }
    if (unchecked.length > 0) {
      fields.push({
        type: 'note',
        id: 'fetchFailed',
        label: 'Could not check some bundles',
        body: [
          ...unchecked.map((c) => `- **${c.name}**: ${c.fetchError}`),
          '',
          'These bundles are left as they are. Retry this step to check them again.',
        ].join('\n'),
        variant: 'warning',
      });
    }
    return {
      title: 'Refresh custom bundles',
      description:
        drifted.length > 0
          ? 'These git-sourced bundles have new commits upstream. Pulling them re-parses the bundle and offers any changed agents/skills as part of this upgrade.'
          : 'Some git-sourced bundles could not be checked for upstream changes.',
      fields,
      submitLabel: 'Continue',
    };
  },

  async apply(ctx, args): Promise<BundleResyncApply> {
    const detected = args.detected;
    const selected = new Set(extractSelectedIds(args.formValues));
    const targets = detected.candidates.filter(
      (c) => c.hasUpstreamChange && selected.has(c.bundleId),
    );
    if (targets.length === 0) {
      return { resyncedBundleIds: [], warnings: [] };
    }
    const bundleStorageRoot = process.env.BUNDLE_STORAGE_ROOT ?? '/var/lib/haive/bundles';
    const warnings: string[] = [];
    const resyncedBundleIds: string[] = [];
    for (const target of targets) {
      const payload: BundleJobPayload = {
        bundleId: target.bundleId,
        userId: ctx.userId,
      };
      try {
        await handleResyncGit(payload, ctx.db, bundleStorageRoot);
        resyncedBundleIds.push(target.bundleId);
      } catch (err) {
        const msg = safeErrorMessage(err);
        warnings.push(`bundle ${target.name} resync failed: ${msg}`);
        ctx.logger.warn({ err, bundleId: target.bundleId }, 'bundle resync failed');
      }
    }
    ctx.logger.info(
      {
        resyncedCount: resyncedBundleIds.length,
        warningCount: warnings.length,
      },
      'bundle-resync apply complete',
    );
    return { resyncedBundleIds, warnings };
  },
};
