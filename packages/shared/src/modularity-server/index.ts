import { asc } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { composableStepEntrySchema, type ComposableStepEntry } from '../modularity/contracts.js';

export interface StepCatalogRead {
  synced: boolean;
  orderedRows: { stepId: string; workflowType: string; stepIndex: number | null }[];
  stepIds: Set<string>;
  dispatchesCli: Set<string>;
  composable: Map<string, ComposableStepEntry>;
  steps: { stepId: string; source: string; title: string; entry: ComposableStepEntry }[];
  invalid: { stepId: string; source: string }[];
}

/** `ordered` sorts in SQL: a JS sort would not reproduce the database's collation order. */
export async function readStepCatalog(
  handle: Pick<Database, 'select'>,
  opts: { ordered?: boolean; lock?: boolean } = {},
): Promise<StepCatalogRead> {
  const read = handle
    .select({
      stepId: schema.stepCatalog.stepId,
      workflowType: schema.stepCatalog.workflowType,
      stepIndex: schema.stepCatalog.stepIndex,
      source: schema.stepCatalog.source,
      title: schema.stepCatalog.title,
      dispatchesCli: schema.stepCatalog.dispatchesCli,
      composable: schema.stepCatalog.composable,
      entry: schema.stepCatalog.entry,
    })
    .from(schema.stepCatalog);
  const ordered = opts.ordered ? read.orderBy(asc(schema.stepCatalog.stepId)) : read;
  const rows = await (opts.lock ? ordered.for('share') : ordered);
  const catalog: StepCatalogRead = {
    synced: rows.length > 0,
    orderedRows: rows.map(({ stepId, workflowType, stepIndex }) => ({
      stepId,
      workflowType,
      stepIndex,
    })),
    stepIds: new Set(rows.map((r) => r.stepId)),
    dispatchesCli: new Set(rows.filter((r) => r.dispatchesCli).map((r) => r.stepId)),
    composable: new Map(),
    steps: [],
    invalid: [],
  };
  for (const row of rows) {
    if (!row.composable) continue;
    const parsed = composableStepEntrySchema.safeParse(row.entry);
    if (!parsed.success) {
      catalog.invalid.push({ stepId: row.stepId, source: row.source });
      continue;
    }
    catalog.composable.set(row.stepId, parsed.data);
    catalog.steps.push({
      stepId: row.stepId,
      source: row.source,
      title: row.title,
      entry: parsed.data,
    });
  }
  return catalog;
}

export * from './module-dependencies.js';
export * from './module-drain.js';
export * from './custom-tools-switch.js';

export * from './derived-task-types.js';
