import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@haive/database';
import type {
  BundleComposerCredentialOption,
  BundleComposerInitial,
  CustomBundleSourceType,
  FormSchema,
  FormValues,
} from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';

export interface CustomBundleSummary {
  id: string;
  name: string;
  sourceType: CustomBundleSourceType;
  enabledKinds: ('agent' | 'skill')[];
  status: 'active' | 'syncing' | 'failed';
  itemCount: number;
  agentCount: number;
  skillCount: number;
  lastSyncError: string | null;
}

export interface CustomBundlesDetect {
  initialBundles: BundleComposerInitial[];
  credentialOptions: BundleComposerCredentialOption[];
  repositoryId: string | null;
}

export interface CustomBundlesApply {
  bundles: CustomBundleSummary[];
  bundleIds: string[];
  warnings: string[];
}

async function loadRepositoryId(ctx: StepContext): Promise<string | null> {
  const rows = await ctx.db
    .select({ repositoryId: schema.tasks.repositoryId })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, ctx.taskId))
    .limit(1);
  return rows[0]?.repositoryId ?? null;
}

async function loadInitialBundles(
  ctx: StepContext,
  repositoryId: string,
): Promise<BundleComposerInitial[]> {
  const bundles = await ctx.db
    .select({
      id: schema.customBundles.id,
      name: schema.customBundles.name,
      sourceType: schema.customBundles.sourceType,
      gitUrl: schema.customBundles.gitUrl,
      gitBranch: schema.customBundles.gitBranch,
      archiveFilename: schema.customBundles.archiveFilename,
      enabledKinds: schema.customBundles.enabledKinds,
      status: schema.customBundles.status,
      lastSyncError: schema.customBundles.lastSyncError,
    })
    .from(schema.customBundles)
    .where(eq(schema.customBundles.repositoryId, repositoryId));

  if (bundles.length === 0) return [];

  const counts = await ctx.db
    .select({
      bundleId: schema.customBundleItems.bundleId,
    })
    .from(schema.customBundleItems)
    .where(
      inArray(
        schema.customBundleItems.bundleId,
        bundles.map((b) => b.id),
      ),
    );
  const countByBundle = new Map<string, number>();
  for (const row of counts) {
    countByBundle.set(row.bundleId, (countByBundle.get(row.bundleId) ?? 0) + 1);
  }

  return bundles.map((b) => ({
    id: b.id,
    name: b.name,
    sourceType: b.sourceType as 'zip' | 'git',
    gitUrl: b.gitUrl ?? undefined,
    gitBranch: b.gitBranch ?? undefined,
    archiveFilename: b.archiveFilename ?? undefined,
    enabledKinds: b.enabledKinds as ('agent' | 'skill')[],
    itemCount: countByBundle.get(b.id) ?? 0,
    status: b.status as 'active' | 'syncing' | 'failed',
    lastSyncError: b.lastSyncError ?? undefined,
  }));
}

async function loadCredentialOptions(ctx: StepContext): Promise<BundleComposerCredentialOption[]> {
  const rows = await ctx.db
    .select({ id: schema.repoCredentials.id, label: schema.repoCredentials.label })
    .from(schema.repoCredentials)
    .where(eq(schema.repoCredentials.userId, ctx.userId));
  return rows.map((r) => ({ id: r.id, label: r.label }));
}

async function summarizeBundle(
  ctx: StepContext,
  repositoryId: string,
  bundleId: string,
): Promise<CustomBundleSummary | null> {
  const row = await ctx.db.query.customBundles.findFirst({
    where: and(
      eq(schema.customBundles.id, bundleId),
      eq(schema.customBundles.repositoryId, repositoryId),
    ),
  });
  if (!row) return null;
  const items = await ctx.db
    .select({ kind: schema.customBundleItems.kind })
    .from(schema.customBundleItems)
    .where(eq(schema.customBundleItems.bundleId, bundleId));
  let agentCount = 0;
  let skillCount = 0;
  for (const item of items) {
    if (item.kind === 'agent') agentCount += 1;
    else if (item.kind === 'skill') skillCount += 1;
  }
  return {
    id: row.id,
    name: row.name,
    sourceType: row.sourceType as CustomBundleSourceType,
    enabledKinds: row.enabledKinds as ('agent' | 'skill')[],
    status: row.status as 'active' | 'syncing' | 'failed',
    itemCount: items.length,
    agentCount,
    skillCount,
    lastSyncError: row.lastSyncError ?? null,
  };
}

/** Submitted form values from the bundle composer. The React side maintains
 *  bundle CRUD via /api/bundles/* routes during composition; by submission
 *  time, every entry has a real `id` from `custom_bundles`. */
function extractBundleIdsFromValues(values: FormValues, fieldId: string): string[] {
  const raw = values[fieldId];
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === 'object' && 'id' in entry) {
      const id = (entry as { id: unknown }).id;
      if (typeof id === 'string' && id.length > 0) ids.push(id);
    } else if (typeof entry === 'string' && entry.length > 0) {
      ids.push(entry);
    }
  }
  return ids;
}

const BUNDLES_FIELD_ID = 'bundles';

export const customBundlesStep: StepDefinition<CustomBundlesDetect, CustomBundlesApply> = {
  metadata: {
    id: '06_3-custom-bundles',
    workflowType: 'onboarding',
    index: 5.5,
    title: 'Custom agent / skill bundles',
    description:
      'Optionally import curated bundles of agents and skills from a ZIP archive or a git repository. Bundle items are surfaced in the agent and skill steps as default-checked candidates.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<CustomBundlesDetect> {
    const repositoryId = await loadRepositoryId(ctx);
    const initialBundles = repositoryId ? await loadInitialBundles(ctx, repositoryId) : [];
    const credentialOptions = await loadCredentialOptions(ctx);
    return { initialBundles, credentialOptions, repositoryId };
  },

  form(_ctx: StepContext, detected: CustomBundlesDetect): FormSchema {
    return {
      title: 'Custom bundles',
      description:
        'Add a ZIP archive or a git repository with curated agents and skills. Bundle items will be offered as default-selected entries in the next steps.',
      fields: [
        {
          type: 'bundle-composer',
          id: BUNDLES_FIELD_ID,
          label: 'Bundles for this repository',
          initialBundles: detected.initialBundles,
          allowAddZip: true,
          allowAddGit: true,
          credentialOptions: detected.credentialOptions,
        },
      ],
      submitLabel: 'Continue',
    };
  },

  async apply(ctx, args): Promise<CustomBundlesApply> {
    const repositoryId = await loadRepositoryId(ctx);
    if (!repositoryId) {
      ctx.logger.warn('06_3-custom-bundles: task has no repository_id');
      return { bundles: [], bundleIds: [], warnings: ['task has no repository_id'] };
    }
    const ids = extractBundleIdsFromValues(args.formValues, BUNDLES_FIELD_ID);
    const warnings: string[] = [];
    const bundles: CustomBundleSummary[] = [];
    for (const id of ids) {
      const summary = await summarizeBundle(ctx, repositoryId, id);
      if (!summary) {
        warnings.push(`bundle ${id} not found for this repository`);
        continue;
      }
      if (summary.status === 'syncing') {
        warnings.push(
          `bundle ${summary.name} (${summary.id}) still syncing — items may be incomplete`,
        );
      } else if (summary.status === 'failed') {
        warnings.push(
          `bundle ${summary.name} (${summary.id}) failed: ${summary.lastSyncError ?? 'unknown'}`,
        );
      }
      bundles.push(summary);
    }
    ctx.logger.info(
      {
        repositoryId,
        bundleIds: ids,
        bundleCount: bundles.length,
        totalAgents: bundles.reduce((acc, b) => acc + b.agentCount, 0),
        totalSkills: bundles.reduce((acc, b) => acc + b.skillCount, 0),
      },
      '06_3-custom-bundles apply complete',
    );
    return { bundles, bundleIds: ids, warnings };
  },
};
