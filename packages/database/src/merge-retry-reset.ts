import { sql } from 'drizzle-orm';
import * as schema from './schema/index.js';

/** The merge resolver's state with its retry budget handed back and every other key kept, since
 *  the repository routes read `merged`/`mergedAt` from failed rows. For a step row reset to rerun. */
export const ZERO_MERGE_RETRIES = sql`CASE WHEN jsonb_typeof(${schema.taskSteps.mergeResolveState} -> 'conflictRetries') = 'number' THEN jsonb_set(${schema.taskSteps.mergeResolveState}, '{conflictRetries}', '0'::jsonb) ELSE ${schema.taskSteps.mergeResolveState} END`;
