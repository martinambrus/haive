import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { INSTALL_LABEL, installId, logger } from '@haive/shared';
import { getDb } from '../db.js';

const exec = promisify(execFile);
const log = logger.child({ module: 'runtime-runner-ownership' });
const reported = new Set<string>();

/** Labels are immutable: another install's label always wins over a matching task id.
 *  Legacy runners require a live owner row. A deleted legacy owner cannot be distinguished
 *  from another install's runner, so keeping its container/volume is the safe upgrade cost. */
export async function ownsRuntimeRunner(
  id: string,
  label: string | null | undefined,
  legacyOwnerExists: () => Promise<boolean>,
): Promise<boolean> {
  if (label === installId()) return true;
  const unlabeled = !label || label === '<no value>';
  if (unlabeled) {
    try {
      if (await legacyOwnerExists()) return true;
    } catch {
      // An unavailable database cannot prove ownership either.
    }
  }
  if (!reported.has(id)) {
    reported.add(id);
    log.info({ id, install: label ?? null }, 'keeping runtime runner whose ownership is unproven');
  }
  return false;
}

export function ownsTaskRunner(
  id: string,
  label: string | null | undefined,
  taskId: string | null,
  db?: Database,
): Promise<boolean> {
  return ownsRuntimeRunner(id, label, async () => {
    if (!taskId) return false;
    return !!(await (db ?? getDb()).query.tasks.findFirst({
      where: eq(schema.tasks.id, taskId),
      columns: { id: true },
    }));
  });
}

/** Task-end sweeps must check install identity too: a task label alone is daemon-global. */
export async function listOwnedTaskRunnerIds(kind: string, taskId: string): Promise<string[]> {
  const { stdout } = await exec(
    'docker',
    [
      'ps',
      '-a',
      '--filter',
      `label=${kind}=1`,
      '--filter',
      `label=haive.task.id=${taskId}`,
      '--format',
      `{{.ID}}\t{{.Label "${INSTALL_LABEL}"}}`,
    ],
    { timeout: 15_000 },
  );
  const ids: string[] = [];
  for (const line of stdout.split('\n')) {
    const [id, label] = line.split('\t');
    if (id && (await ownsTaskRunner(id, label, taskId))) ids.push(id);
  }
  return ids;
}
