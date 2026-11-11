import { isUtf8 } from 'node:buffer';
import { and, eq, isNull } from 'drizzle-orm';
import { lockRepositoryTasksKey, schema, type Database } from '@haive/database';
import {
  buildRepoCliRulesBlock,
  CLI_RULES_DISK_PATH,
  CLI_RULES_END,
  CLI_RULES_SCHEMA_VERSION,
  CLI_RULES_START,
  CLI_RULES_TEMPLATE_ID,
  CLI_RULES_TEMPLATE_KIND,
  extractRegion,
  getHaiveVersion,
  logger,
  normalizeContent,
  sha256Hex,
  upsertRegion,
} from '@haive/shared';
import { rewriteFileIfNoFollow, updateFileNoFollow } from '@haive/shared/fs-safe';
import { readUpgradeFile, RULES_FILE_READ_CAP } from '@haive/shared/rules-files';
import { markProjectStateDirty } from '@haive/shared/project-state-outbox';
import { isRtkChoiceRecorded, readRenderContextColumn } from '@haive/shared/project-state';
import { recordableContext } from '../step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import { readAgentRulesOverrideRaw } from '../step-engine/_agent-rules-override.js';
import { cliRulesRegionRecord } from '../step-engine/steps/onboarding/_rules-files.js';
import { writeApplicableTemplateIds, type RulesOverrideImport } from './sync.js';
import { lockProjectState, refuseHeldCheckout } from './write.js';

/** The override import has committed and its task released the checkout. Like 02, write the
 * region in the checkout and supersede/record its ledger row before the owed record is flushed.
 * The outbox owns only .haive-data/state, never AGENTS.md. A refusal leaves the next upgrade
 * its ordinary drift; it must not turn a task ending into a failed task or overwrite an edit. */
export async function reconcileTaskEndRules(
  db: Database,
  repositoryId: string,
  repoPath: string,
  taskId: string,
  imported: RulesOverrideImport,
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await lockRepositoryTasksKey(tx, repositoryId);
      await lockProjectState(tx, repositoryId);
      await refuseHeldCheckout(tx, repositoryId, repoPath);
      const [repo] = await tx
        .select()
        .from(schema.repositories)
        .where(eq(schema.repositories.id, repositoryId));
      if (
        !repo ||
        (repo.storagePath ?? repo.localPath) !== repoPath ||
        (repo.onboardingResetAt?.getTime() ?? null) !== (imported.resetAt?.getTime() ?? null) ||
        (await readAgentRulesOverrideRaw(tx, repositoryId)) !== imported.after
      )
        throw new Error('repository changed after the rules override import');
      const [outbox] = await tx
        .select({ intent: schema.projectStateOutbox.writeIntent })
        .from(schema.projectStateOutbox)
        .where(eq(schema.projectStateOutbox.repositoryId, repositoryId));
      if (outbox?.intent) throw new Error('an interrupted project state write awaits recovery');

      const read = await readUpgradeFile(repoPath, CLI_RULES_DISK_PATH);
      if (read.kind === 'unread') throw new Error(`AGENTS.md cannot be read: ${read.reason}`);
      const before = read.kind === 'text' ? read.text : null;
      const region = extractRegion(before ?? '', CLI_RULES_START, CLI_RULES_END);
      const oldRender = buildRepoCliRulesBlock(imported.before);
      const render = buildRepoCliRulesBlock(imported.after);
      const hash = (text: string | null) =>
        text === null ? null : sha256Hex(normalizeContent(text));
      if (hash(region) !== hash(oldRender) && hash(region) !== hash(render))
        throw new Error('the rules region was edited or removed after it was rendered');
      const next = upsertRegion(before ?? '', render ?? '', CLI_RULES_START, CLI_RULES_END);
      const writtenRegion = extractRegion(next, CLI_RULES_START, CLI_RULES_END);
      const now = new Date();
      // As in 02/12, retiring and replacing a live path is one transaction. This is an
      // adoption of the imported setting, not output a rollback of the ended upgrade owns.
      await tx
        .update(schema.onboardingArtifacts)
        .set({ supersededAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.onboardingArtifacts.repositoryId, repositoryId),
            eq(schema.onboardingArtifacts.diskPath, CLI_RULES_DISK_PATH),
            isNull(schema.onboardingArtifacts.supersededAt),
          ),
        );
      if (writtenRegion !== null && render !== null) {
        const record = cliRulesRegionRecord(writtenRegion, render, new Set());
        const context = readRenderContextColumn(repo.renderContext);
        // Snapshots omit the column's own flag (a row carrying it fails isRenderContextSnapshot)
        // and, as 01 records them, keep `rtkEnabled` only where an RTK choice was made.
        let snapshot: Record<string, unknown> | null = null;
        if (context.kind === 'column') {
          const { rtkChoiceRecorded, ...rest } = context.column;
          snapshot = recordableContext(
            rest,
            isRtkChoiceRecorded(rtkChoiceRecorded, repo.rtkChoiceMadeAt),
          );
        }
        await tx.insert(schema.onboardingArtifacts).values({
          userId: repo.userId,
          repositoryId,
          taskId,
          diskPath: CLI_RULES_DISK_PATH,
          templateId: CLI_RULES_TEMPLATE_ID,
          templateKind: CLI_RULES_TEMPLATE_KIND,
          templateSchemaVersion: CLI_RULES_SCHEMA_VERSION,
          templateContentHash: record.templateContentHash,
          writtenHash: record.writtenHash,
          writtenContent: record.content,
          lastObservedDiskHash: record.writtenHash,
          userModified: false,
          formValuesSnapshot: snapshot,
          source: 'backfill',
          sourceStepId: 'task-end-rules-resync',
          haiveVersion: getHaiveVersion(),
        });
      }
      await writeApplicableTemplateIds(tx, {
        repositoryId,
        userId: repo.userId,
        requireResolved: repo.renderContext !== null,
      });
      await markProjectStateDirty(tx, repositoryId);
      // No database wait while fs-safe parks the file. Judge the same bytes we read before
      // recording them, and preserve all text outside the region. A racing save stays put.
      if (next === before || (before === null && render === null)) return;
      if (before === null) {
        const result = await updateFileNoFollow(
          repoPath,
          CLI_RULES_DISK_PATH,
          (current) => (current === null ? next : null),
          { create: true, maxBytes: RULES_FILE_READ_CAP },
        );
        if (result !== 'created') throw new Error('AGENTS.md appeared after the rules read');
      } else {
        const result = await rewriteFileIfNoFollow(
          repoPath,
          CLI_RULES_DISK_PATH,
          (bytes) =>
            isUtf8(bytes) && bytes.equals(Buffer.from(before)) ? Buffer.from(next) : null,
          { maxBytes: RULES_FILE_READ_CAP },
        );
        if (result !== 'rewritten') throw new Error('AGENTS.md changed after the rules read');
      }
    });
  } catch (err) {
    logger.warn(
      { err, repositoryId, taskId },
      'task-end rules region not reconciled; the next upgrade will offer it',
    );
  }
}
