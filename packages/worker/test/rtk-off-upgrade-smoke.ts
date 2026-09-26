/**
 * Switching RTK off, through the real 01/02 upgrade steps, against a database and a seeded blank
 * repository whose rules files carry the RTK block. One throwaway user, deleted after.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  logger,
  normalizeContent,
  RTK_REF_MARKER_END,
  RTK_REF_MARKER_START,
  sha256Hex,
  type FormSchema,
} from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import { seedBlankScaffold } from '../src/repo/blank-scaffold.js';
import { TaskCancelledError, type StepContext } from '../src/step-engine/step-definition.js';
import {
  upgradePlanStep,
  type UpgradePlanDetect,
} from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import { upgradeApplyStep } from '../src/step-engine/steps/onboarding-upgrade/02-upgrade-apply.js';
import { upgradeRollbackStep } from '../src/step-engine/steps/onboarding-upgrade/04-upgrade-rollback.js';
import {
  buildClaudeSettingsJson,
  buildRtkAwarenessBlock,
} from '../src/step-engine/steps/onboarding/_rtk-templates.js';

const log = logger.child({ module: 'rtk-off-upgrade-smoke' });

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

/** What a person submitting the form untouched sends: every field's own default. */
function defaultValues(form: FormSchema | null): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of form?.fields ?? []) {
    if ('defaults' in field) values[field.id] = field.defaults;
    else if ('default' in field) values[field.id] = field.default;
  }
  return values;
}

const SETTINGS = '.claude/settings.json';
const RTK_ITEM = 'rtk.claude-settings';

async function main(): Promise<void> {
  initDatabase(process.env.DATABASE_URL!);
  const db = getDb();
  const userId = randomUUID();
  const repositoryId = randomUUID();
  const now = new Date();
  const repoPath = await mkdtemp(join(tmpdir(), 'rtk-off-upgrade-smoke-'));

  try {
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'rtk-off-upgrade-smoke',
      emailBlindIndex: `rtk-off-upgrade-smoke-${randomBytes(6).toString('hex')}`,
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
      label: 'rtk-off-upgrade-smoke',
      rulesContent: '',
    });
    await db.insert(schema.repositories).values({
      id: repositoryId,
      userId,
      name: 'rtk-off-upgrade-smoke',
      source: 'blank',
      rtkEnabled: true,
      createdAt: now,
      updatedAt: now,
    });
    const seeded = await seedBlankScaffold(
      db,
      { userId, repositoryId, repoName: 'rtk-off-upgrade-smoke' },
      repoPath,
    );
    if (!seeded.includes(SETTINGS)) throw new Error(`scaffold wrote no ${SETTINGS}`);

    const controller = new AbortController();
    const ctxFor = (taskId: string, taskStepId: string, path = repoPath): StepContext => ({
      round: 0,
      taskId,
      taskStepId,
      userId,
      repoPath: path,
      workspacePath: path,
      sandboxWorkdir: '/haive/workdir',
      cliProviderId: null,
      db,
      logger: log.child({ taskStepId }),
      signal: controller.signal,
      throwIfCancelled: () => {
        if (controller.signal.aborted) throw new TaskCancelledError();
      },
      async emitProgress() {},
    });
    const readOrNull = (rel: string) =>
      readFile(join(repoPath, rel), 'utf8').then(
        (text) => text,
        () => null,
      );
    const liveRowsAt = (rel: string) =>
      db
        .select({ id: schema.onboardingArtifacts.id })
        .from(schema.onboardingArtifacts)
        .where(
          and(
            eq(schema.onboardingArtifacts.repositoryId, repositoryId),
            eq(schema.onboardingArtifacts.diskPath, rel),
            isNull(schema.onboardingArtifacts.supersededAt),
          ),
        );

    /** One upgrade task: 01 plans, its output stored where 02 reads it. */
    async function upgrade(title: string, repo = { id: repositoryId, path: repoPath }) {
      const [task] = await db
        .insert(schema.tasks)
        .values({
          userId,
          repositoryId: repo.id,
          type: 'onboarding_upgrade',
          title,
          status: 'running',
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: schema.tasks.id });
      const [planRow, applyRow] = await db
        .insert(schema.taskSteps)
        .values([
          { taskId: task!.id, stepId: '01-upgrade-plan', stepIndex: 1, title, status: 'running' },
          { taskId: task!.id, stepId: '02-upgrade-apply', stepIndex: 2, title, status: 'pending' },
        ])
        .returning({ id: schema.taskSteps.id });
      const planCtx = ctxFor(task!.id, planRow!.id, repo.path);
      const detected = await upgradePlanStep.detect!(planCtx);
      const planned = await upgradePlanStep.apply(planCtx, {
        detected,
        formValues: {},
        iteration: 0,
        previousIterations: [],
      });
      await db
        .update(schema.taskSteps)
        .set({ output: planned as unknown as Record<string, unknown>, status: 'done' })
        .where(eq(schema.taskSteps.id, planRow!.id));
      const applyCtx = ctxFor(task!.id, applyRow!.id, repo.path);
      const plan = await upgradeApplyStep.detect!(applyCtx);
      const form = upgradeApplyStep.form!(applyCtx, plan) as FormSchema | null;
      return { detected, form, applyCtx, plan };
    }
    const settingsEntry = (detected: UpgradePlanDetect) =>
      detected.entries.find((e) => e.diskPath === SETTINGS);
    /** A rollback task of the most recent completed upgrade, run to the end. */
    async function rollback(title: string) {
      const [task] = await db
        .insert(schema.tasks)
        .values({
          userId,
          repositoryId,
          type: 'onboarding_upgrade',
          title,
          status: 'running',
          metadata: { mode: 'rollback' },
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: schema.tasks.id });
      const [row] = await db
        .insert(schema.taskSteps)
        .values({
          taskId: task!.id,
          stepId: '04-upgrade-rollback',
          stepIndex: 4,
          title,
          status: 'running',
        })
        .returning({ id: schema.taskSteps.id });
      const rollbackCtx = ctxFor(task!.id, row!.id);
      const detected = await upgradeRollbackStep.detect!(rollbackCtx);
      return upgradeRollbackStep.apply(rollbackCtx, {
        detected,
        formValues: {},
        iteration: 0,
        previousIterations: [],
      });
    }

    // ---- RTK on: the backfill adopts the settings file, recording the choice -------------
    const first = await upgrade('rtk-off-upgrade-smoke first');
    check(
      'with RTK on the settings file is adopted',
      settingsEntry(first.detected)?.bucket === 'new_artifact',
      {
        bucket: settingsEntry(first.detected)?.bucket,
      },
    );
    check(
      'and no RTK block is offered for removal',
      (first.detected.rtkBlockLeftovers ?? []).length === 0,
    );
    check('its row is live', (await liveRowsAt(SETTINGS)).length === 1);

    // ---- RTK switched off, the settings file edited since -----------------------------------
    const agentsMd = `# Project\n\nOur notes.\n`;
    await writeFile(join(repoPath, 'AGENTS.md'), `${agentsMd}${buildRtkAwarenessBlock()}`);
    const claudeMd = '@AGENTS.md\n';
    await writeFile(
      join(repoPath, 'CLAUDE.md'),
      `${claudeMd}${RTK_REF_MARKER_START}\n@RTK.md\n${RTK_REF_MARKER_END}\n`,
    );
    const editedSettings = buildClaudeSettingsJson().replace('{\n', '{\n  "model": "ours",\n');
    await writeFile(join(repoPath, SETTINGS), editedSettings);
    await db
      .update(schema.repositories)
      .set({ rtkEnabled: false })
      .where(eq(schema.repositories.id, repositoryId));

    const off = await upgrade('rtk-off-upgrade-smoke off');
    check(
      'the settings file is offered for removal',
      settingsEntry(off.detected)?.bucket === 'obsolete',
      {
        bucket: settingsEntry(off.detected)?.bucket,
      },
    );
    check(
      'the plan names the rules files holding the block',
      JSON.stringify(off.detected.rtkBlockLeftovers) === JSON.stringify(['AGENTS.md', 'CLAUDE.md']),
      off.detected.rtkBlockLeftovers,
    );
    check('and the form says so', off.form?.fields.some((f) => f.id === 'rtkBlockNote') === true);
    // RTK switched back on while the form was parked: the plan no longer holds, so nothing is applied.
    await db
      .update(schema.repositories)
      .set({ rtkEnabled: true })
      .where(eq(schema.repositories.id, repositoryId));
    const refused = await upgradeApplyStep
      .apply(off.applyCtx, {
        detected: off.plan,
        formValues: { selectedObsoleteRemovals: [settingsEntry(off.detected)!.entryId] },
        iteration: 0,
        previousIterations: [],
      })
      .then(
        () => null,
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
    check(
      'a plan RTK was switched back on under is refused, and nothing is touched',
      refused?.startsWith('RTK was switched on after this upgrade was planned') === true &&
        (await readOrNull(SETTINGS)) === editedSettings &&
        (await readOrNull('AGENTS.md'))?.includes(RTK_REF_MARKER_START) === true,
      refused,
    );
    await db
      .update(schema.repositories)
      .set({ rtkEnabled: false })
      .where(eq(schema.repositories.id, repositoryId));

    const offValues = defaultValues(off.form);
    // Only the RTK change: the rules region these upgrades also offer is declined.
    offValues.selectedNew = [];
    offValues.selectedObsoleteRemovals = [settingsEntry(off.detected)!.entryId];
    const offApplied = await upgradeApplyStep.apply(off.applyCtx, {
      detected: off.plan,
      formValues: offValues,
      iteration: 0,
      previousIterations: [],
    });
    check(
      'the block comes out of AGENTS.md, and nothing else',
      (await readOrNull('AGENTS.md')) === agentsMd,
      {
        now: await readOrNull('AGENTS.md'),
      },
    );
    check(
      'the legacy import comes out of CLAUDE.md',
      (await readOrNull('CLAUDE.md')) === claudeMd,
      {
        now: await readOrNull('CLAUDE.md'),
      },
    );
    check(
      'both are handed to the commit',
      ['AGENTS.md', 'CLAUDE.md'].every((f) => offApplied.writtenPaths?.includes(f)),
      offApplied.writtenPaths,
    );
    check(
      'the edited settings file is kept, and said so',
      (await readOrNull(SETTINGS)) === editedSettings &&
        offApplied.warnings.some((w) => w.startsWith(`kept ${SETTINGS}:`)),
      offApplied.warnings,
    );
    check('and its row stays live', (await liveRowsAt(SETTINGS)).length === 1);
    const [repoRow] = await db
      .select({ applicable: schema.repositories.applicableTemplateIds })
      .from(schema.repositories)
      .where(eq(schema.repositories.id, repositoryId));
    check(
      'the RTK settings template no longer applies to the repository',
      repoRow?.applicable !== null && !repoRow?.applicable?.includes(RTK_ITEM),
      repoRow?.applicable,
    );

    // ---- the hook taken out of the edited file, and a rollback that puts it back ------------
    const strip = await upgrade('rtk-off-upgrade-smoke strip');
    const stripEntryId = settingsEntry(strip.detected)!.entryId;
    const stripField = strip.form?.fields.find((f) => f.id === 'selectedRtkHookStrips');
    const ourKeyOnly = '{\n  "model": "ours"\n}\n';
    check(
      'the edited settings file is offered for its RTK hook to come out, unticked',
      stripField?.type === 'multi-select' &&
        (stripField.defaults ?? []).length === 0 &&
        stripField.options.some(
          (o) => o.value === stripEntryId && o.details?.current === ourKeyOnly,
        ),
      stripField,
    );
    const stripValues = defaultValues(strip.form);
    stripValues.selectedNew = [];
    stripValues.selectedRtkHookStrips = [stripEntryId];
    const stripApplied = await upgradeApplyStep.apply(strip.applyCtx, {
      detected: strip.plan,
      formValues: stripValues,
      iteration: 0,
      previousIterations: [],
    });
    check(
      "only the hook comes out, the person's key stays, and the file is handed to the commit",
      (await readOrNull(SETTINGS)) === ourKeyOnly &&
        stripApplied.writtenPaths?.includes(SETTINGS) === true,
      { now: await readOrNull(SETTINGS), writtenPaths: stripApplied.writtenPaths },
    );
    const [stripRow] = await db
      .select({
        source: schema.onboardingArtifacts.source,
        writtenHash: schema.onboardingArtifacts.writtenHash,
        writtenContent: schema.onboardingArtifacts.writtenContent,
      })
      .from(schema.onboardingArtifacts)
      .where(
        and(
          eq(schema.onboardingArtifacts.repositoryId, repositoryId),
          eq(schema.onboardingArtifacts.diskPath, SETTINGS),
          isNull(schema.onboardingArtifacts.supersededAt),
        ),
      );
    check(
      'its live row records what the file holds and claims none of it',
      stripRow?.source === 'upgrade' &&
        stripRow.writtenContent === ourKeyOnly &&
        stripRow.writtenHash === sha256Hex(normalizeContent(buildClaudeSettingsJson())),
      stripRow,
    );
    await db
      .update(schema.taskSteps)
      .set({ output: stripApplied as unknown as Record<string, unknown>, status: 'done' })
      .where(eq(schema.taskSteps.id, strip.applyCtx.taskStepId));
    await db
      .update(schema.tasks)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(schema.tasks.id, strip.applyCtx.taskId));
    await rollback('rtk-off-upgrade-smoke strip rollback');
    check('a rollback puts the hook back', (await readOrNull(SETTINGS)) === editedSettings, {
      now: await readOrNull(SETTINGS),
    });

    // ---- a retry after an attempt that took the hook out and failed before recording it ----
    const retry = await upgrade('rtk-off-upgrade-smoke strip retry');
    await writeFile(join(repoPath, SETTINGS), ourKeyOnly);
    const retryValues = defaultValues(retry.form);
    retryValues.selectedNew = [];
    retryValues.selectedRtkHookStrips = [settingsEntry(retry.detected)!.entryId];
    const retried = await upgradeApplyStep.apply(retry.applyCtx, {
      detected: retry.plan,
      formValues: retryValues,
      iteration: 0,
      previousIterations: [],
    });
    check(
      'a retry records the edit an earlier attempt made, and hands the file to the commit',
      (await readOrNull(SETTINGS)) === ourKeyOnly &&
        retried.writtenPaths?.includes(SETTINGS) === true,
      { writtenPaths: retried.writtenPaths, warnings: retried.warnings },
    );
    await db
      .update(schema.taskSteps)
      .set({ output: retried as unknown as Record<string, unknown>, status: 'done' })
      .where(eq(schema.taskSteps.id, retry.applyCtx.taskStepId));
    await db
      .update(schema.tasks)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(schema.tasks.id, retry.applyCtx.taskId));
    await rollback('rtk-off-upgrade-smoke strip retry rollback');
    check('and its rollback puts the hook back', (await readOrNull(SETTINGS)) === editedSettings, {
      now: await readOrNull(SETTINGS),
    });

    // ---- a byte that is not UTF-8: decoding would write U+FFFD in its place ----------------
    const notUtf8 = Buffer.from(editedSettings.replace('"ours"', '"oursé"'), 'latin1');
    await writeFile(join(repoPath, SETTINGS), notUtf8);
    const lossy = await upgrade('rtk-off-upgrade-smoke not utf-8');
    const lossyValues = defaultValues(lossy.form);
    lossyValues.selectedNew = [];
    lossyValues.selectedRtkHookStrips = [settingsEntry(lossy.detected)!.entryId];
    const lossyApplied = await upgradeApplyStep.apply(lossy.applyCtx, {
      detected: lossy.plan,
      formValues: lossyValues,
      iteration: 0,
      previousIterations: [],
    });
    check(
      'a file that is not valid UTF-8 keeps every byte, and says why',
      (await readFile(join(repoPath, SETTINGS))).equals(notUtf8) &&
        lossyApplied.writtenPaths?.includes(SETTINGS) !== true &&
        lossyApplied.warnings.some((w) => w.includes('not valid UTF-8')),
      lossyApplied.warnings,
    );

    // ---- the same bytes Haive wrote, and a second upgrade ----------------------------------
    await writeFile(join(repoPath, SETTINGS), buildClaudeSettingsJson());
    const again = await upgrade('rtk-off-upgrade-smoke again');
    check(
      'the settings file is offered again',
      settingsEntry(again.detected)?.bucket === 'obsolete',
      {
        bucket: settingsEntry(again.detected)?.bucket,
      },
    );
    check('with no block left to offer', (again.detected.rtkBlockLeftovers ?? []).length === 0);
    check('or to announce', again.form?.fields.some((f) => f.id === 'rtkBlockNote') !== true);
    const againValues = defaultValues(again.form);
    againValues.selectedNew = [];
    againValues.selectedObsoleteRemovals = [settingsEntry(again.detected)!.entryId];
    const againApplied = await upgradeApplyStep.apply(again.applyCtx, {
      detected: again.plan,
      formValues: againValues,
      iteration: 0,
      previousIterations: [],
    });
    check(
      'an unedited settings file is removed, and handed to the commit as a removal',
      (await readOrNull(SETTINGS)) === null &&
        againApplied.deletedPaths?.includes(SETTINGS) === true,
      againApplied.deletedPaths,
    );
    check('and its row retired', (await liveRowsAt(SETTINGS)).length === 0);
    check(
      'the rules files are left alone',
      (await readOrNull('AGENTS.md')) === agentsMd &&
        (await readOrNull('CLAUDE.md')) === claudeMd &&
        !againApplied.writtenPaths?.includes('AGENTS.md'),
      againApplied.writtenPaths,
    );

    // ---- RTK switched back on: what the banner now offers, the plan offers too --------------
    await db
      .update(schema.repositories)
      .set({ rtkEnabled: true })
      .where(eq(schema.repositories.id, repositoryId));
    const back = await upgrade('rtk-off-upgrade-smoke back on');
    check(
      'with RTK back on the settings file the off-upgrade removed is offered as a new file',
      settingsEntry(back.detected)?.bucket === 'new_artifact',
      { bucket: settingsEntry(back.detected)?.bucket },
    );

    // ---- a blank repository switched off before its first upgrade ---------------------------
    const seededId = randomUUID();
    const seededPath = await mkdtemp(join(tmpdir(), 'rtk-off-upgrade-smoke-seeded-'));
    try {
      await db.insert(schema.repositories).values({
        id: seededId,
        userId,
        name: 'rtk-off-upgrade-smoke seeded',
        source: 'blank',
        rtkEnabled: true,
        createdAt: now,
        updatedAt: now,
      });
      await seedBlankScaffold(
        db,
        { userId, repositoryId: seededId, repoName: 'rtk-off-upgrade-smoke seeded' },
        seededPath,
      );
      await db
        .update(schema.repositories)
        .set({ rtkEnabled: false })
        .where(eq(schema.repositories.id, seededId));
      const seeded = { id: seededId, path: seededPath };
      const offeredForRemoval = (form: FormSchema | null, entryId: string | undefined) => {
        const field = form?.fields.find((f) => f.id === 'selectedObsoleteRemovals');
        return (
          field?.type === 'multi-select' && field.options.some((option) => option.value === entryId)
        );
      };

      const firstSeeded = await upgrade('rtk-off-upgrade-smoke seeded first', seeded);
      const seededEntry = settingsEntry(firstSeeded.detected);
      check(
        'the settings file the scaffold seeded is offered for removal though no row records it',
        seededEntry?.bucket === 'obsolete' &&
          seededEntry.liveArtifactId === null &&
          offeredForRemoval(firstSeeded.form, seededEntry.entryId),
        { bucket: seededEntry?.bucket },
      );
      const skipValues = defaultValues(firstSeeded.form);
      skipValues.selectedNew = [];
      await upgradeApplyStep.apply(firstSeeded.applyCtx, {
        detected: firstSeeded.plan,
        formValues: skipValues,
        iteration: 0,
        previousIterations: [],
      });
      check(
        'left unticked, it stays',
        (await readFile(join(seededPath, SETTINGS), 'utf8')) === buildClaudeSettingsJson(),
      );

      const seededRows = await db
        .select({ diskPath: schema.onboardingArtifacts.diskPath })
        .from(schema.onboardingArtifacts)
        .where(
          and(
            eq(schema.onboardingArtifacts.repositoryId, seededId),
            isNull(schema.onboardingArtifacts.supersededAt),
          ),
        );
      check(
        'the first upgrade recorded rows, none of them for the settings file',
        seededRows.length > 0 && !seededRows.some((r) => r.diskPath === SETTINGS),
        seededRows.length,
      );
      const secondSeeded = await upgrade('rtk-off-upgrade-smoke seeded second', seeded);
      const againEntry = settingsEntry(secondSeeded.detected);
      check(
        'the next upgrade, with the rows the first recorded, offers it again',
        againEntry?.bucket === 'obsolete' &&
          offeredForRemoval(secondSeeded.form, againEntry.entryId),
        { bucket: againEntry?.bucket },
      );
      const removeValues = defaultValues(secondSeeded.form);
      removeValues.selectedNew = [];
      removeValues.selectedObsoleteRemovals = [againEntry!.entryId];
      const removed = await upgradeApplyStep.apply(secondSeeded.applyCtx, {
        detected: secondSeeded.plan,
        formValues: removeValues,
        iteration: 0,
        previousIterations: [],
      });
      check(
        'and removes it when picked, handed to the commit as a removal',
        (await readFile(join(seededPath, SETTINGS), 'utf8').catch(() => null)) === null &&
          removed.deletedPaths?.includes(SETTINGS) === true,
        removed.deletedPaths,
      );
    } finally {
      await rm(seededPath, { recursive: true, force: true });
    }

    // ---- a repository onboarded before RTK: its plan's "off" was never anyone's choice ------------
    const legacyId = randomUUID();
    const legacyPath = await mkdtemp(join(tmpdir(), 'rtk-off-upgrade-smoke-legacy-'));
    try {
      await db.insert(schema.repositories).values({
        id: legacyId,
        userId,
        name: 'rtk-off-upgrade-smoke legacy',
        source: 'local_path',
        localPath: legacyPath,
        createdAt: now,
        updatedAt: now,
      });
      const [onboarded] = await db
        .insert(schema.tasks)
        .values({
          userId,
          repositoryId: legacyId,
          type: 'onboarding',
          title: 'rtk-off-upgrade-smoke legacy onboarding',
          status: 'completed',
          completedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: schema.tasks.id });
      await db.insert(schema.taskSteps).values({
        taskId: onboarded!.id,
        stepId: '07-generate-files',
        stepIndex: 7,
        title: 'Generate files',
        status: 'done',
        detectOutput: {},
      });
      const legacy = await upgrade('rtk-off-upgrade-smoke legacy', {
        id: legacyId,
        path: legacyPath,
      });
      check(
        'a plan from before RTK is off, but not by a choice the repository recorded',
        legacy.detected.renderCtxSnapshot.rtkEnabled === false &&
          legacy.detected.rtkFollowsLive === false,
        { rtkFollowsLive: legacy.detected.rtkFollowsLive },
      );
      const legacyValues = defaultValues(legacy.form);
      legacyValues.selectedNew = [];
      const legacyRefusal = await upgradeApplyStep
        .apply(legacy.applyCtx, {
          detected: legacy.plan,
          formValues: legacyValues,
          iteration: 0,
          previousIterations: [],
        })
        .then(
          () => null,
          (err: unknown) => (err instanceof Error ? err.message : String(err)),
        );
      check('so it applies with the column at its default', legacyRefusal === null, legacyRefusal);
    } finally {
      await rm(legacyPath, { recursive: true, force: true });
    }

    if (failures > 0) {
      log.error({ failures, checks }, 'smoke FAILED');
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify({ smoke: 'RTK_OFF_UPGRADE_OK', checks }));
    }
  } catch (err) {
    log.error({ err }, 'smoke failed');
    process.exitCode = 1;
  } finally {
    try {
      await getDb().delete(schema.users).where(eq(schema.users.id, userId));
    } catch (cleanupErr) {
      log.warn({ err: cleanupErr }, 'cleanup failed');
    }
    await rm(repoPath, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  }
}

void main();
