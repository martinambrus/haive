import { spawn } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { BundleJobPayload, FormSchema, FormValues } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { gitRevParseHead, handleResyncGit } from '../../../repo/bundle-ingest.js';

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
  /** True when at least one candidate has remote drift; gates whether the
   *  form renders the multi-select. */
  hasAny: boolean;
}

export interface BundleResyncApply {
  resyncedBundleIds: string[];
  warnings: string[];
}

const FIELD_ID = 'bundlesToPull';

/** `git fetch` plus `git rev-parse origin/<branch>` returning the remote head.
 *  Pure read operation — does NOT update the local working tree, so on its
 *  own it cannot break a parser run. The actual pull happens in apply(). */
function fetchRemoteHead(cwd: string, branch: string | null): Promise<string> {
  return new Promise((resolve, reject) => {
    const fetchArgs = ['fetch', '--quiet', 'origin'];
    if (branch) fetchArgs.push(branch);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'echo',
    };
    const fetchProc = spawn('git', fetchArgs, { cwd, env });
    let stderr = '';
    fetchProc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    fetchProc.on('error', reject);
    fetchProc.on('exit', (code) => {
      if (code !== 0) {
        const msg = stderr.replace(/https?:\/\/[^@]+@/g, 'https://***@').trim();
        reject(new Error(`git fetch failed (exit ${code}): ${msg}`));
        return;
      }
      const ref = branch ? `origin/${branch}` : 'origin/HEAD';
      const revProc = spawn('git', ['rev-parse', ref], { cwd });
      let stdout = '';
      let revStderr = '';
      revProc.stdout.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      revProc.stderr.on('data', (d: Buffer) => {
        revStderr += d.toString();
      });
      revProc.on('error', reject);
      revProc.on('exit', (revCode) => {
        if (revCode === 0) {
          resolve(stdout.trim());
          return;
        }
        reject(new Error(`git rev-parse ${ref} failed (exit ${revCode}): ${revStderr.trim()}`));
      });
    });
  });
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
      remoteCommit = await fetchRemoteHead(row.storageRoot, row.gitBranch ?? null);
    } catch (err) {
      fetchError = err instanceof Error ? err.message : String(err);
    }
    let localHead: string | null = null;
    try {
      localHead = await gitRevParseHead(row.storageRoot);
    } catch {
      localHead = null;
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
    const hasAny = candidates.some((c) => c.hasUpstreamChange);
    return { candidates, hasAny };
  },

  form(_ctx, detected): FormSchema | null {
    const drifted = detected.candidates.filter((c) => c.hasUpstreamChange);
    if (drifted.length === 0) {
      return null;
    }
    return {
      title: 'Refresh custom bundles',
      description:
        'These git-sourced bundles have new commits upstream. Pulling them re-parses the bundle and offers any changed agents/skills as part of this upgrade.',
      fields: [
        {
          type: 'multi-select',
          id: FIELD_ID,
          label: 'Pull these bundles',
          options: drifted.map((c) => ({
            value: c.bundleId,
            label: `${c.name}${c.branch ? ` @ ${c.branch}` : ''} — ${c.lastSyncCommit?.slice(0, 7) ?? '(unknown)'} → ${c.remoteCommit?.slice(0, 7) ?? '(unknown)'}`,
          })),
          defaults: drifted.map((c) => c.bundleId),
        },
      ],
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
        const msg = err instanceof Error ? err.message : String(err);
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
