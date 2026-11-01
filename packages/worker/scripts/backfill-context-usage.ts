/** Bounded historical context repair. Defaults to read-only inventory (25 steps).
 * Run from packages/worker: pnpm exec tsx scripts/backfill-context-usage.ts [options]
 * --limit 1..100 --after UUID --task-id UUID --step-id UUID
 * --apply --artifact-root /absolute/repository/root --backup existing-dir/new-file.json
 * --undo --artifact-root /absolute/repository/root --backup existing-dir/saved-file.json
 * Undo is also dry-run unless --apply is supplied. Files are metadata/derived values only.
 * No provider/config initialization, expiry sweep, model call, migration or automatic pagination.
 */
import path from 'node:path';
import { createDatabase } from '@haive/database';
import { logger } from '@haive/shared';
import {
  applyContextInventory,
  inventoryContext,
  readContextBackup,
  undoContextBackup,
} from '../src/maintenance/context-backfill.js';

const log = logger.child({ module: 'context-backfill-operator' });
const flags = new Map<string, string | boolean>();
const booleans = new Set(['--apply', '--undo']);
const valued = new Set([
  '--limit',
  '--after',
  '--task-id',
  '--step-id',
  '--artifact-root',
  '--backup',
]);
let db: ReturnType<typeof createDatabase> | undefined;
try {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (flags.has(arg)) throw new Error('duplicate option');
    if (booleans.has(arg)) flags.set(arg, true);
    else if (valued.has(arg) && args[i + 1] && !args[i + 1]!.startsWith('--'))
      flags.set(arg, args[++i]!);
    else throw new Error('unknown option or missing option value');
  }
  const value = (flag: string) => flags.get(flag) as string | undefined;
  const apply = flags.has('--apply');
  const undo = flags.has('--undo');
  const root = value('--artifact-root');
  const backup = value('--backup');
  if ((apply || undo) && (!root || !path.isAbsolute(root) || !backup))
    throw new Error('apply/undo require absolute --artifact-root and relative --backup');
  if (undo && ['--limit', '--after', '--task-id', '--step-id'].some((flag) => flags.has(flag)))
    throw new Error('undo scope comes entirely from the backup');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required');
  db = createDatabase(url);
  if (undo) {
    const result = await undoContextBackup(db, await readContextBackup(root!, backup!), apply);
    log.info({ mode: apply ? 'undo-apply' : 'undo-dry-run', ...result }, 'context undo result');
    if (result.conflicts) process.exitCode = 2;
  } else {
    const result = await inventoryContext(db, {
      limit: value('--limit') === undefined ? undefined : Number(value('--limit')),
      after: value('--after'),
      taskId: value('--task-id'),
      stepId: value('--step-id'),
    });
    log.info(
      { mode: apply ? 'apply' : 'dry-run', ...result },
      'bounded context inventory; elided peaks are lower bounds and skipped without a stored peak',
    );
    if (apply) {
      const mutation = await applyContextInventory(db, result, root!, backup!);
      log.info(
        mutation,
        'context apply result; immutable backup includes planned rows, including conflicts',
      );
      if (mutation.conflicts) process.exitCode = 2;
    }
  }
} catch (err) {
  // Query exceptions may contain raw parameters/evidence. Never emit them or the connection URL.
  log.error(
    { errorType: err instanceof Error ? err.name : 'unknown' },
    'operator refused or failed; no raw error/parameters emitted',
  );
  process.exitCode = 1;
} finally {
  await db?.$client.end({ timeout: 5 });
}
