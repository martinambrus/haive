import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  FOREIGN_TEMPLATE,
  PROJECT_STATE_IMPORT_STEP_ID,
  isRtkChoiceRecorded,
  localTemplateId,
  readRenderContextColumn,
  type LocalBundle,
  type ProjectStateClaim,
} from '@haive/shared/project-state';
import { extractBundleItemId } from '../step-engine/_custom-bundle-loader.js';
import { renderContextFromColumn } from '../step-engine/_render-targets.js';
import { recordableContext } from '../step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import { readClaimedBytes } from './claim-disk.js';
import { loadLocalBundles } from './write.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** What every marker of one import shares, read once: the repository's owner, its bundles and the
 *  render context snapshot a marker carries. */
export interface MarkerContext {
  userId: string;
  bundles: LocalBundle[];
  snapshot: Record<string, unknown> | null;
}

export async function loadMarkerContext(
  tx: Tx,
  repositoryId: string,
  repo: { userId: string; renderContext: unknown; rtkChoiceMadeAt: Date | null },
): Promise<MarkerContext> {
  const column = readRenderContextColumn(repo.renderContext);
  const providers =
    column.kind === 'column'
      ? await tx
          .select({ name: schema.cliProviders.name, enabled: schema.cliProviders.enabled })
          .from(schema.cliProviders)
          .where(eq(schema.cliProviders.userId, repo.userId))
      : [];
  return {
    userId: repo.userId,
    bundles: await loadLocalBundles(tx, repositoryId),
    snapshot:
      column.kind === 'column'
        ? (recordableContext(
            renderContextFromColumn(column.column, providers),
            isRtkChoiceRecorded(column.column.rtkChoiceRecorded, repo.rtkChoiceMadeAt),
          ) as unknown as Record<string, unknown>)
        : null,
  };
}

/** A snapshot naming the agent a marker claims: a row whose agent its own snapshot does not accept
 *  reads as a phantom, and the boot repair retires it. */
function acceptingAgent(
  snapshot: Record<string, unknown> | null,
  agentId: string | null,
): Record<string, unknown> | null {
  if (snapshot === null || agentId === null) return snapshot;
  const accepted = Array.isArray(snapshot.acceptedAgentIds)
    ? (snapshot.acceptedAgentIds as string[])
    : [];
  if (accepted.includes(agentId)) return snapshot;
  return { ...snapshot, acceptedAgentIds: [...accepted, agentId].sort() };
}

/** The ledger row an import leaves for a claim it adopted: a `backfill` row of no task, dated by
 *  the import. The bytes are kept only when they are the claim's own. */
export async function insertImportMarker(
  tx: Tx,
  {
    repositoryId,
    repoPath,
    claim,
    now,
    context,
  }: {
    repositoryId: string;
    repoPath: string;
    claim: ProjectStateClaim;
    now: Date;
    context: MarkerContext;
  },
): Promise<void> {
  const mapped = localTemplateId(claim.templateId, context.bundles);
  const foreign = mapped === FOREIGN_TEMPLATE;
  const disk = await readClaimedBytes(repoPath, claim);
  const read = disk === 'unread' ? null : disk;
  const agentId =
    !foreign && claim.kind === 'agent' && mapped.startsWith('agent.')
      ? mapped.slice('agent.'.length)
      : null;
  await tx.insert(schema.onboardingArtifacts).values({
    userId: context.userId,
    repositoryId,
    taskId: null,
    diskPath: claim.path,
    templateId: foreign ? claim.templateId : mapped,
    templateKind: claim.kind,
    templateSchemaVersion: claim.schemaVersion,
    templateContentHash: claim.templateHash,
    writtenHash: claim.writtenHash,
    writtenContent: read !== null && read.hash === claim.writtenHash ? read.content : null,
    lastObservedDiskHash: read?.hash ?? null,
    userModified: false,
    formValuesSnapshot: acceptingAgent(context.snapshot, agentId),
    sourceStepId: PROJECT_STATE_IMPORT_STEP_ID,
    source: 'backfill',
    haiveVersion: claim.haiveVersion === '' ? null : claim.haiveVersion,
    generatedAt: now,
    importedAt: now,
    bundleItemId: foreign ? null : extractBundleItemId(mapped),
  });
}
