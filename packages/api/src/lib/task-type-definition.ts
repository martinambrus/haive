import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { HttpError } from '../context.js';

const BUILTIN_TASK_TYPES: ReadonlySet<string> = new Set(schema.workflowTypeEnum.enumValues);

export async function definitionForCreate(
  handle: Pick<Database, 'select'>,
  slug: string,
  opts: { generic: boolean },
): Promise<{ runListSnapshot: string[] | null }> {
  const [def] = await handle
    .select()
    .from(schema.taskTypeDefinitions)
    .where(eq(schema.taskTypeDefinitions.slug, slug))
    .limit(1);
  if (!def) {
    // The worker seeds the built-ins at boot; until it has, a built-in keeps today's live run list.
    if (BUILTIN_TASK_TYPES.has(slug)) return { runListSnapshot: null };
    throw new HttpError(404, `Unknown task type ${slug}`);
  }
  if (!def.enabled) throw new HttpError(403, `Task type ${slug} is disabled`);
  if (opts.generic && !def.selectable) {
    throw new HttpError(403, `Task type ${slug} cannot be created here`);
  }
  return { runListSnapshot: def.runListStrategy === 'static' ? def.stepIds : null };
}
