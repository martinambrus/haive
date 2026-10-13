import { createHash } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { REPO_OPTIONAL_BUILTIN_TASK_TYPES } from '@haive/shared';
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
      contentHash: createHash('sha256')
        .update(JSON.stringify({ strategy: runListStrategy, stepIds }))
        .digest('hex'),
    };
  });
}

export async function syncTaskTypeDefinitions(db: Database, registry: StepRegistry): Promise<void> {
  const now = new Date();
  const wanted = builtinTaskTypeRows(registry);

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
  });
}
