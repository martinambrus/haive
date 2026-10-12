import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { CONFIG_KEYS, configService, workflowTypeSchema } from '@haive/shared';
import { HttpError } from '../context.js';

const BUILTIN_TASK_TYPES: ReadonlySet<string> = new Set(schema.workflowTypeEnum.enumValues);
const GENERIC_BUILTIN_TASK_TYPES: ReadonlySet<string> = new Set(workflowTypeSchema.options);

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
    if (!BUILTIN_TASK_TYPES.has(slug)) throw new HttpError(404, `Unknown task type ${slug}`);
    if (opts.generic && !GENERIC_BUILTIN_TASK_TYPES.has(slug)) {
      throw new HttpError(403, `Task type ${slug} cannot be created here`);
    }
    return { runListSnapshot: null };
  }
  if (!def.enabled) throw new HttpError(403, `Task type ${slug} is disabled`);
  if (opts.generic && !def.selectable) {
    throw new HttpError(403, `Task type ${slug} cannot be created here`);
  }
  if (
    def.source === 'admin' &&
    !(await configService.getBoolean(CONFIG_KEYS.CUSTOM_TASK_TYPES_ENABLED, false))
  ) {
    throw new HttpError(403, 'Custom task types are disabled on this install');
  }
  if (
    def.source.startsWith('module:') &&
    !(await configService.getBoolean(CONFIG_KEYS.MODULE_TASK_TYPES_ENABLED, false))
  ) {
    throw new HttpError(403, 'Module task types are disabled on this install');
  }
  return { runListSnapshot: def.runListStrategy === 'static' ? def.stepIds : null };
}
