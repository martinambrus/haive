import { asc } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { composableStepEntrySchema, type ComposableStepEntry } from '../modularity/contracts.js';

export interface StepCatalogRead {
  synced: boolean;
  stepIds: Set<string>;
  dispatchesCli: Set<string>;
  composable: Map<string, ComposableStepEntry>;
  steps: { stepId: string; source: string; title: string; entry: ComposableStepEntry }[];
  invalid: { stepId: string; source: string }[];
}

/** `ordered` sorts in SQL: a JS sort would not reproduce the database's collation order. */
export async function readStepCatalog(
  handle: Pick<Database, 'select'>,
  opts: { ordered?: boolean } = {},
): Promise<StepCatalogRead> {
  const read = handle
    .select({
      stepId: schema.stepCatalog.stepId,
      source: schema.stepCatalog.source,
      title: schema.stepCatalog.title,
      dispatchesCli: schema.stepCatalog.dispatchesCli,
      composable: schema.stepCatalog.composable,
      entry: schema.stepCatalog.entry,
    })
    .from(schema.stepCatalog);
  const rows = await (opts.ordered ? read.orderBy(asc(schema.stepCatalog.stepId)) : read);
  const catalog: StepCatalogRead = {
    synced: rows.length > 0,
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
