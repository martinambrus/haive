import { eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { getDb } from '../../db.js';
import type { CliCommandSpec } from '../../cli-adapters/types.js';
import type { DockerRunner } from '../../sandbox/docker-runner.js';
import { recheckSandboxToolchain } from '../../sandbox/toolchain-prompt.js';

/** Persist the same exact removal before any transport can send the changed prompt.
 * SQL replaces only the advisory and its separator, including nested native prompts;
 * no second copy of task text is carried in the queue or read back into memory.
 */
export async function recheckInvocationToolchain(
  spec: CliCommandSpec,
  image: string | null,
  invocationId: string | null,
  runner?: DockerRunner,
  wrapper?: string | null,
  extraEnv?: Record<string, string>,
  db?: Database,
) {
  const checked = await recheckSandboxToolchain(spec, image, runner, wrapper, extraEnv);
  if (checked.strippedBlock && invocationId) {
    await (db ?? getDb())
      .update(schema.cliInvocations)
      .set({
        prompt: sql`replace(${schema.cliInvocations.prompt}, ${checked.strippedBlock + '\n\n'}, '')`,
      })
      .where(eq(schema.cliInvocations.id, invocationId));
  }
  return checked;
}
