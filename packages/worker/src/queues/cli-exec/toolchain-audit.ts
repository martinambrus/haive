import { eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { getDb } from '../../db.js';
import type { CliCommandSpec } from '../../cli-adapters/types.js';
import type { DockerRunner } from '../../sandbox/docker-runner.js';
import { recheckSandboxToolchain } from '../../sandbox/toolchain-prompt.js';

/** Persist the same exact removal before any transport can send the changed prompt.
 * New dispatch stamps guard the exact position so a redelivery cannot consume a task quote.
 * Legacy stamps still remove their stamped match ordinals, including nested native prompts;
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
    const separator = checked.strippedBlock + '\n\n';
    const offset = spec.sandboxToolchain?.offset;
    await (db ?? getDb())
      .update(schema.cliInvocations)
      .set({
        prompt:
          offset !== undefined
            ? sql`case
              when substr(${schema.cliInvocations.prompt}, ${offset + 1}, length(${separator})) = ${separator}
              then overlay(${schema.cliInvocations.prompt} placing '' from ${offset + 1} for length(${separator}))
              else ${schema.cliInvocations.prompt}
            end`
            : sql`(
          select coalesce(string_agg(piece,
            case when ordinal - 1 = any(${sql.param(checked.strippedOccurrences)}::int[])
              then '' else ${checked.strippedBlock + '\n\n'} end order by ordinal), ${schema.cliInvocations.prompt})
          from unnest(string_to_array(${schema.cliInvocations.prompt}, ${checked.strippedBlock + '\n\n'}))
            with ordinality as parts(piece, ordinal)
        )`,
      })
      .where(eq(schema.cliInvocations.id, invocationId));
  }
  return checked;
}
