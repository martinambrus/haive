/**
 * 02's untrack path, with the keep choice, and a rollback of it (04), against a database: the real
 * steps, a hand-built plan. A row an upgrade untracked goes back live where no live row stands at its
 * path, and nothing on disk changes. One throwaway user, deleted after.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '@haive/database';
import { logger, normalizeContent, sha256Hex } from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import type { StepContext } from '../src/step-engine/step-definition.js';
import type {
  UpgradePlanEntry,
  UpgradePlanOutput,
} from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import { upgradeApplyStep } from '../src/step-engine/steps/onboarding-upgrade/02-upgrade-apply.js';
import { upgradeRollbackStep } from '../src/step-engine/steps/onboarding-upgrade/04-upgrade-rollback.js';
import { REFERENCE_CONTEXT } from '../src/step-engine/template-manifest.js';

const log = logger.child({ module: 'untrack-rollback-smoke' });

if (!process.env.DATABASE_URL) {
  console.error('[smoke] missing env DATABASE_URL');
  process.exit(2);
}

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  checks += 1;
  if (ok) {
    log.info({ check: name }, 'ok');
    return;
  }
  failures += 1;
  log.error({ check: name, detail }, 'FAILED');
}

const hashOf = (text: string) => sha256Hex(normalizeContent(text));
const bodyOf = (diskPath: string) => `${diskPath} as Haive wrote it\n`;

interface FileSeed {
  diskPath: string;
  templateId: string;
}

async function main(): Promise<void> {
  initDatabase(process.env.DATABASE_URL!);
  const db = getDb();
  const userId = randomUUID();
  const now = new Date();
  const roots: string[] = [];

  const readOrNull = (root: string, rel: string) =>
    readFile(join(root, rel), 'utf8').then(
      (text) => text,
      () => null,
    );

  try {
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'untrack-rollback-smoke',
      emailBlindIndex: `untrack-rollback-smoke-${randomBytes(6).toString('hex')}`,
      passwordHash: 'smoke-not-real',
      role: 'user',
      status: 'active',
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.cliProviders).values({
      userId,
      name: 'claude-code',
      label: 'untrack-rollback-smoke',
      rulesContent: '',
    });

    /** A repository onboarded with live rows for these files, which are on disk as the rows record them. */
    async function world(label: string, files: FileSeed[]) {
      const repositoryId = randomUUID();
      const root = await mkdtemp(join(tmpdir(), `untrack-rollback-smoke-${label}-`));
      roots.push(root);
      await db.insert(schema.repositories).values({
        id: repositoryId,
        userId,
        name: `untrack-rollback-smoke ${label}`,
        source: 'git_https',
        status: 'ready',
        createdAt: now,
        updatedAt: now,
      });
      const task = async (
        type: 'onboarding' | 'onboarding_upgrade',
        status: 'running' | 'completed',
        metadata: Record<string, unknown> | null = null,
      ) => {
        const [row] = await db
          .insert(schema.tasks)
          .values({
            userId,
            repositoryId,
            type,
            status,
            title: `${label} ${type}`,
            metadata,
            completedAt: status === 'completed' ? new Date() : null,
          })
          .returning({ id: schema.tasks.id });
        return row!.id;
      };
      const onboarding = await task('onboarding', 'completed');
      const rows: Record<string, string> = {};
      const entries: UpgradePlanEntry[] = [];
      for (const f of files) {
        const body = bodyOf(f.diskPath);
        await mkdir(join(root, f.diskPath, '..'), { recursive: true });
        await writeFile(join(root, f.diskPath), body);
        const [row] = await db
          .insert(schema.onboardingArtifacts)
          .values({
            userId,
            repositoryId,
            taskId: onboarding,
            diskPath: f.diskPath,
            templateId: f.templateId,
            templateKind: f.templateId.startsWith('custom.') ? 'custom-agent' : 'agent',
            templateSchemaVersion: 1,
            templateContentHash: hashOf(body),
            writtenHash: hashOf(body),
            writtenContent: body,
            lastObservedDiskHash: hashOf(body),
            formValuesSnapshot: REFERENCE_CONTEXT as unknown as Record<string, unknown>,
            sourceStepId: '12-post-onboarding',
            source: 'onboarding',
          })
          .returning({ id: schema.onboardingArtifacts.id });
        rows[f.diskPath] = row!.id;
        entries.push({
          entryId: `e:${f.diskPath}`,
          bucket: 'obsolete',
          templateId: f.templateId,
          templateKind: f.templateId.startsWith('custom.') ? 'custom-agent' : 'agent',
          diskPath: f.diskPath,
          liveArtifactId: row!.id,
          currentContent: body,
          newContent: null,
          baselineContent: body,
          currentHash: hashOf(body),
          baselineWrittenHash: hashOf(body),
          newContentHash: null,
          baselineTemplateContentHash: hashOf(body),
          currentTemplateContentHash: null,
          templateSchemaVersion: 1,
          delta: null,
        });
      }
      const plan = {
        repositoryId,
        ranBackfill: false,
        entries,
        counts: {},
        installedTemplateSetHash: null,
        currentTemplateSetHash: 'set',
        renderCtxSnapshot: REFERENCE_CONTEXT as unknown as Record<string, unknown>,
        backfilledRows: 0,
      } as unknown as UpgradePlanOutput;
      const ctxFor = (taskId: string): StepContext =>
        ({
          round: 0,
          taskId,
          taskStepId: randomUUID(),
          userId,
          repoPath: root,
          workspacePath: root,
          sandboxWorkdir: '/haive/workdir',
          cliProviderId: null,
          db,
          logger: log,
          signal: new AbortController().signal,
          throwIfCancelled: () => undefined,
          async emitProgress() {},
        }) as unknown as StepContext;
      const entryOf = (diskPath: string) => entries.find((e) => e.diskPath === diskPath)!.entryId;

      /** The upgrade, finished with its 02 output stored where a rollback of it reads it. `edit`
       *  turns that output into an older one. */
      async function upgrade(
        formValues: Record<string, unknown>,
        edit: (output: Record<string, unknown>) => void = () => undefined,
      ) {
        const upgradeTask = await task('onboarding_upgrade', 'running');
        const output = (await upgradeApplyStep.apply(ctxFor(upgradeTask), {
          detected: plan,
          formValues,
          iteration: 0,
          previousIterations: [],
        })) as unknown as Record<string, unknown>;
        edit(output);
        await db.insert(schema.taskSteps).values({
          taskId: upgradeTask,
          stepId: '02-upgrade-apply',
          stepIndex: 2,
          title: 'apply',
          status: 'done',
          output,
        });
        await db
          .update(schema.tasks)
          .set({ status: 'completed', completedAt: new Date() })
          .where(eq(schema.tasks.id, upgradeTask));
        return output;
      }
      let lastWarnings: string[] = [];
      /** A rollback of the upgrade, run to the end; what it threw, or null. */
      async function rollback(): Promise<string | null> {
        const rollbackTask = await task('onboarding_upgrade', 'running', { mode: 'rollback' });
        try {
          const ctx = ctxFor(rollbackTask);
          const detected = await upgradeRollbackStep.detect!(ctx);
          lastWarnings = detected.warnings;
          await upgradeRollbackStep.apply(ctx, {
            detected,
            formValues: {},
            iteration: 0,
            previousIterations: [],
          });
          return null;
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        } finally {
          await db
            .update(schema.tasks)
            .set({ status: 'completed', completedAt: new Date() })
            .where(eq(schema.tasks.id, rollbackTask));
        }
      }
      const rowsAt = (diskPath: string) =>
        db
          .select({
            id: schema.onboardingArtifacts.id,
            source: schema.onboardingArtifacts.source,
            templateId: schema.onboardingArtifacts.templateId,
            writtenHash: schema.onboardingArtifacts.writtenHash,
            supersededAt: schema.onboardingArtifacts.supersededAt,
          })
          .from(schema.onboardingArtifacts)
          .where(
            and(
              eq(schema.onboardingArtifacts.repositoryId, repositoryId),
              eq(schema.onboardingArtifacts.diskPath, diskPath),
            ),
          );
      const liveAt = async (diskPath: string) =>
        (await rowsAt(diskPath)).filter((r) => r.supersededAt === null);
      const liveRows = () =>
        db
          .select({ id: schema.onboardingArtifacts.id })
          .from(schema.onboardingArtifacts)
          .where(
            and(
              eq(schema.onboardingArtifacts.repositoryId, repositoryId),
              isNull(schema.onboardingArtifacts.supersededAt),
            ),
          );
      return {
        root,
        repositoryId,
        onboarding,
        rows,
        entryOf,
        upgrade,
        rollback,
        warnings: () => lastWarnings,
        rowsAt,
        liveAt,
        liveRows,
      };
    }

    const KEPT: FileSeed = { diskPath: '.claude/agents/old.md', templateId: 'agent.old' };
    const REMOVED: FileSeed = { diskPath: '.claude/agents/older.md', templateId: 'agent.older' };

    // ---- O5: a Haive row picked to be kept, beside a file removed in the same upgrade ------------
    const w1 = await world('o5', [KEPT, REMOVED]);
    await w1.upgrade({
      selectedObsoleteUntracks: [w1.entryOf(KEPT.diskPath)],
      selectedObsoleteRemovals: [w1.entryOf(REMOVED.diskPath)],
    });
    check(
      'O5: a file picked to be kept loses its row and keeps its bytes',
      (await w1.liveAt(KEPT.diskPath)).length === 0 &&
        (await readOrNull(w1.root, KEPT.diskPath)) === bodyOf(KEPT.diskPath),
      await w1.rowsAt(KEPT.diskPath),
    );
    check(
      'O5: and the file picked to be removed is gone',
      (await readOrNull(w1.root, REMOVED.diskPath)) === null,
    );
    const failure1 = await w1.rollback();
    const keptRows = await w1.liveAt(KEPT.diskPath);
    check(
      'O5: a rollback puts the kept file’s row back live, as a rollback row recording what it did',
      failure1 === null &&
        keptRows.length === 1 &&
        keptRows[0]!.source === 'rollback' &&
        keptRows[0]!.templateId === KEPT.templateId &&
        keptRows[0]!.writtenHash === hashOf(bodyOf(KEPT.diskPath)),
      { failure1, keptRows },
    );
    check(
      'O5: and leaves the kept file as it was',
      (await readOrNull(w1.root, KEPT.diskPath)) === bodyOf(KEPT.diskPath),
    );
    const removedRows = await w1.liveAt(REMOVED.diskPath);
    check(
      'O5: and puts back the removed file once, with one live row',
      (await readOrNull(w1.root, REMOVED.diskPath)) === bodyOf(REMOVED.diskPath) &&
        removedRows.length === 1,
      removedRows,
    );
    check(
      'O5: and no row beyond those two is live',
      (await w1.liveRows()).length === 2,
      (await w1.liveRows()).length,
    );

    // ---- O5b: a dangling bundle row, which 02 untracks without being asked ----------------------
    const dangling: FileSeed = {
      diskPath: '.claude/agents/bundled.md',
      templateId: `custom.bundle-1.${randomUUID()}`,
    };
    const w2 = await world('o5b', [dangling]);
    await w2.upgrade({});
    check(
      'O5b: a dangling bundle row is untracked by default, its file left alone',
      (await w2.liveAt(dangling.diskPath)).length === 0 &&
        (await readOrNull(w2.root, dangling.diskPath)) === bodyOf(dangling.diskPath),
    );
    const failure2 = await w2.rollback();
    const danglingRows = await w2.liveAt(dangling.diskPath);
    check(
      'O5b: and a rollback puts it back live, the file as it was',
      failure2 === null &&
        danglingRows.length === 1 &&
        danglingRows[0]!.source === 'rollback' &&
        danglingRows[0]!.templateId === dangling.templateId &&
        (await readOrNull(w2.root, dangling.diskPath)) === bodyOf(dangling.diskPath),
      { failure2, danglingRows },
    );
    check(
      'O5b: and the rollback of an upgrade that only untracked a row does not say there is nothing to revert',
      !w2.warnings().some((w) => w.includes('nothing to revert')),
      w2.warnings(),
    );

    // ---- O5c: a live row stands at the path when the rollback runs ------------------------------
    const w3 = await world('o5c', [KEPT]);
    await w3.upgrade({ selectedObsoleteUntracks: [w3.entryOf(KEPT.diskPath)] });
    const untracked3 = (await w3.liveAt(KEPT.diskPath)).length === 0;
    check('O5c: the kept file is untracked first', untracked3, await w3.rowsAt(KEPT.diskPath));
    if (untracked3) {
      const [later] = await db
        .insert(schema.onboardingArtifacts)
        .values({
          userId,
          repositoryId: w3.repositoryId,
          taskId: w3.onboarding,
          diskPath: KEPT.diskPath,
          templateId: 'agent.later',
          templateKind: 'agent',
          templateSchemaVersion: 1,
          templateContentHash: 'f'.repeat(64),
          writtenHash: 'f'.repeat(64),
          sourceStepId: '12-post-onboarding',
          source: 'onboarding',
        })
        .returning({ id: schema.onboardingArtifacts.id });
      const failure3 = await w3.rollback();
      const standing = await w3.liveAt(KEPT.diskPath);
      check(
        'O5c: and a live row standing there at rollback time is left alone, with no error',
        failure3 === null && standing.length === 1 && standing[0]!.id === later!.id,
        { failure3, standing },
      );
      check(
        'O5c: and the kept file is as it was',
        (await readOrNull(w3.root, KEPT.diskPath)) === bodyOf(KEPT.diskPath),
      );
    }

    // ---- O5d: an older 02 output that names no untracked row ------------------------------------
    const w4 = await world('o5d', [KEPT]);
    await w4.upgrade({ selectedObsoleteUntracks: [w4.entryOf(KEPT.diskPath)] }, (output) => {
      delete output.untrackedRowIds;
    });
    check(
      'O5d: the kept file is untracked first',
      (await w4.liveAt(KEPT.diskPath)).length === 0,
      await w4.rowsAt(KEPT.diskPath),
    );
    const failure4 = await w4.rollback();
    check(
      'O5d: and an older output without the list restores no row, with no error',
      failure4 === null &&
        (await w4.liveAt(KEPT.diskPath)).length === 0 &&
        (await readOrNull(w4.root, KEPT.diskPath)) === bodyOf(KEPT.diskPath),
      { failure4, rows: await w4.rowsAt(KEPT.diskPath) },
    );
  } finally {
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.$client.end({ timeout: 5 });
    await Promise.all(roots.map((d) => rm(d, { recursive: true, force: true })));
  }
}

main()
  .then(() => {
    if (failures > 0) {
      log.error({ checks, failures }, 'untrack-rollback smoke FAILED');
      process.exit(1);
    }
    console.log(JSON.stringify({ smoke: 'UNTRACK_ROLLBACK_OK', checks }));
    process.exit(0);
  })
  .catch((err) => {
    log.error({ err }, 'untrack-rollback smoke crashed');
    process.exit(1);
  });
