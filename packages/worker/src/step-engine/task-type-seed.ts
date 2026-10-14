import { createHash } from 'node:crypto';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { schema, type Database, type DbTx } from '@haive/database';
import { REPO_OPTIONAL_BUILTIN_TASK_TYPES, logger } from '@haive/shared';
import {
  moduleTaskTypeSlug,
  validateTaskTypeDefaults,
  type ComposableStepEntry,
  type ModuleManifest,
} from '@haive/shared/modularity';
import type { LoadedWorkerModule, ModuleTaskTypeOutcome } from '../modules/loader.js';
import { CORE_COMPOSABLE_STEPS } from './composable-core.js';
import type { StepRegistry } from './registry.js';

type RunListStrategy = (typeof schema.runListStrategyEnum.enumValues)[number];

export interface BuiltinTaskTypeRow {
  slug: string;
  displayName: string;
  runListStrategy: RunListStrategy;
  stepIds: string[] | null;
  source: 'builtin';
  selectable: boolean;
  requiresRepository: boolean;
  sortOrder: number;
  contentHash: string;
}

const DISPLAY_NAMES: Record<string, string> = {
  onboarding: 'Onboarding',
  workflow: 'Workflow',
  env_replicate: 'Env replicate',
  onboarding_upgrade: 'Onboarding upgrade',
  kb_author: 'KB enrichment',
  run_app: 'Run app',
  plan_build: 'Plan build',
  plan_chat: 'Plan chat',
  advisory: 'Advisory research',
  plan_sequence: 'Plan sequence',
  plan_merge: 'Plan merge',
};

const DYNAMIC_STRATEGIES: Record<string, RunListStrategy> = {
  workflow: 'workflow_paths',
  run_app: 'run_app_modes',
};
const SELECTABLE_SLUGS = ['onboarding', 'workflow', 'onboarding_upgrade', 'run_app'];

const contentHashOf = (runListStrategy: RunListStrategy, stepIds: string[] | null): string =>
  createHash('sha256')
    .update(JSON.stringify({ strategy: runListStrategy, stepIds }))
    .digest('hex');

export function builtinTaskTypeRows(registry: StepRegistry): BuiltinTaskTypeRow[] {
  return schema.workflowTypeEnum.enumValues.map((slug, index) => {
    const runListStrategy = DYNAMIC_STRATEGIES[slug] ?? 'static';
    const stepIds =
      runListStrategy === 'static' ? registry.listByWorkflow(slug).map((d) => d.metadata.id) : null;
    return {
      slug,
      displayName: DISPLAY_NAMES[slug] ?? slug,
      runListStrategy,
      stepIds,
      source: 'builtin',
      selectable: SELECTABLE_SLUGS.includes(slug),
      requiresRepository: !REPO_OPTIONAL_BUILTIN_TASK_TYPES.has(slug),
      sortOrder: index,
      contentHash: contentHashOf(runListStrategy, stepIds),
    };
  });
}

async function seedModuleTaskTypes(
  tx: DbTx,
  manifest: ModuleManifest,
  now: Date,
  composables: ReadonlyMap<string, ComposableStepEntry>,
): Promise<ModuleTaskTypeOutcome> {
  const source = `module:${manifest.id}`;
  const declared = (manifest.taskTypes ?? []).map((seed) => ({
    slug: moduleTaskTypeSlug(manifest.id, seed.slug),
    displayName: seed.displayName,
    description: seed.description ?? null,
    runListStrategy: seed.runListStrategy,
    stepIds: seed.stepIds,
    preAnswerDefaults: seed.preAnswerDefaults ?? {},
    stepLoopLimitDefaults: seed.stepLoopLimitDefaults ?? {},
    enabled: true,
    selectable: seed.selectable,
    source,
    requiresRepository: seed.requiresRepository,
    sortOrder: seed.sortOrder ?? 0,
    contentHash: contentHashOf(seed.runListStrategy, seed.stepIds),
  }));
  const invalid = declared
    .map((row) => ({
      slug: row.slug,
      issues: validateTaskTypeDefaults(
        {
          stepIds: row.stepIds ?? [],
          preAnswerDefaults: row.preAnswerDefaults,
          stepLoopLimitDefaults: row.stepLoopLimitDefaults,
        },
        composables,
      ),
    }))
    .filter(({ issues }) => issues.length > 0);
  for (const { slug, issues } of invalid) {
    logger.warn(
      { module: manifest.id, slug, issues },
      'module task type seed skipped: its defaults fail the checks an admin task type gets',
    );
  }
  const rejected = new Set(invalid.map((i) => i.slug));
  const rows = declared.filter((row) => !rejected.has(row.slug));
  const slugs = rows.map((r) => r.slug);

  for (const row of rows) {
    await tx
      .insert(schema.taskTypeDefinitions)
      .values({ ...row, updatedAt: now })
      .onConflictDoUpdate({
        target: schema.taskTypeDefinitions.slug,
        // enabled, displayName and sortOrder stay what the insert or the admin made them.
        set: {
          runListStrategy: row.runListStrategy,
          stepIds: row.stepIds,
          description: row.description,
          preAnswerDefaults: row.preAnswerDefaults,
          stepLoopLimitDefaults: row.stepLoopLimitDefaults,
          selectable: row.selectable,
          requiresRepository: row.requiresRepository,
          contentHash: row.contentHash,
          updatedAt: now,
        },
        setWhere: eq(schema.taskTypeDefinitions.source, source),
      });
  }

  const stored = await tx
    .select({ slug: schema.taskTypeDefinitions.slug, source: schema.taskTypeDefinitions.source })
    .from(schema.taskTypeDefinitions)
    .where(inArray(schema.taskTypeDefinitions.slug, slugs));
  const holders = new Map(stored.map((r) => [r.slug, r.source]));
  const outcome: ModuleTaskTypeOutcome = { seeded: [], conflicts: [] };
  for (const slug of slugs) {
    const heldBy = holders.get(slug);
    if (heldBy === source) {
      outcome.seeded.push(slug);
    } else if (heldBy !== undefined) {
      // Failing the boot would leave the install unbootable, and the other row is not ours to change.
      logger.warn(
        { module: manifest.id, slug, heldBy },
        'module task type seed skipped: the slug is held by another row',
      );
      outcome.conflicts.push({ slug, heldBy });
    }
  }

  await tx
    .update(schema.taskTypeDefinitions)
    .set({ selectable: false, updatedAt: now })
    .where(
      and(
        eq(schema.taskTypeDefinitions.source, source),
        notInArray(
          schema.taskTypeDefinitions.slug,
          declared.map((r) => r.slug),
        ),
        eq(schema.taskTypeDefinitions.selectable, true),
      ),
    );
  if (invalid.length > 0) outcome.invalid = invalid;
  return outcome;
}

export async function syncTaskTypeDefinitions(
  db: Database,
  registry: StepRegistry,
  loaded: readonly LoadedWorkerModule[],
): Promise<Record<string, ModuleTaskTypeOutcome>> {
  const now = new Date();
  const wanted = builtinTaskTypeRows(registry);
  const composables = new Map(
    [...CORE_COMPOSABLE_STEPS, ...loaded.flatMap((m) => m.composable)].map(
      (entry) => [entry.stepId, entry] as const,
    ),
  );
  const outcomes: Record<string, ModuleTaskTypeOutcome> = {};

  await db.transaction(async (tx) => {
    for (const row of wanted) {
      await tx
        .insert(schema.taskTypeDefinitions)
        .values({ ...row, updatedAt: now })
        .onConflictDoUpdate({
          target: schema.taskTypeDefinitions.slug,
          set: {
            runListStrategy: row.runListStrategy,
            stepIds: row.stepIds,
            contentHash: row.contentHash,
            source: row.source,
            selectable: row.selectable,
            requiresRepository: row.requiresRepository,
            updatedAt: now,
          },
          setWhere: eq(schema.taskTypeDefinitions.source, 'builtin'),
        });
    }

    const stored = await tx
      .select()
      .from(schema.taskTypeDefinitions)
      .where(
        inArray(
          schema.taskTypeDefinitions.slug,
          wanted.map((r) => r.slug),
        ),
      );
    const storedBySlug = new Map(stored.map((r) => [r.slug, r]));
    for (const row of wanted) {
      const holder = storedBySlug.get(row.slug)?.source;
      if (holder !== 'builtin') {
        throw new Error(
          `task_type_definitions slug ${row.slug} is held by a ${holder} row, not the built-in`,
        );
      }
      const got = storedBySlug.get(row.slug)?.stepIds ?? null;
      if (JSON.stringify(got) !== JSON.stringify(row.stepIds)) {
        throw new Error(
          `task_type_definitions drift for ${row.slug}: stored ${JSON.stringify(got)}, registry ${JSON.stringify(row.stepIds)}`,
        );
      }
    }

    for (const { manifest } of loaded) {
      outcomes[manifest.id] = await seedModuleTaskTypes(tx, manifest, now, composables);
    }
  });
  return outcomes;
}
