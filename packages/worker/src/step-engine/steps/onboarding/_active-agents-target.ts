import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { getCliProviderMetadata, type CliProviderName } from '@haive/shared';
import type { StepContext } from '../../step-definition.js';

export interface ActiveAgentsTarget {
  dir: string;
  ext: '.md' | '.toml';
}

export async function resolveActiveAgentsTarget(
  ctx: StepContext,
): Promise<ActiveAgentsTarget | null> {
  const defaultTarget: ActiveAgentsTarget = { dir: '.claude/agents', ext: '.md' };
  if (!ctx.cliProviderId) return defaultTarget;
  const row = await ctx.db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.id, ctx.cliProviderId),
    columns: { name: true },
  });
  if (!row) return defaultTarget;
  const meta = getCliProviderMetadata(row.name as CliProviderName);
  if (!meta.projectAgentsDir || !meta.agentFileFormat) return null;
  return {
    dir: meta.projectAgentsDir,
    ext: meta.agentFileFormat === 'toml' ? '.toml' : '.md',
  };
}
