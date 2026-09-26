/**
 * The real 01/02 upgrade steps, a rollback of them (04) and the boot repair, against a database and a
 * seeded blank repository holding two edited files and a hand-written AGENTS.md region. One throwaway
 * user, deleted after.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  CLI_RULES_DISK_PATH,
  CLI_RULES_END,
  CLI_RULES_START,
  CLI_RULES_TEMPLATE_KIND,
  logger,
  normalizeContent,
  sha256Hex,
  type FormSchema,
} from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import { unclaimBackfilledEdits } from '../src/data-migrations.js';
import { seedBlankScaffold } from '../src/repo/blank-scaffold.js';
import { TaskCancelledError, type StepContext } from '../src/step-engine/step-definition.js';
import { upgradePlanStep } from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import { upgradeApplyStep } from '../src/step-engine/steps/onboarding-upgrade/02-upgrade-apply.js';
import { upgradeRollbackStep } from '../src/step-engine/steps/onboarding-upgrade/04-upgrade-rollback.js';

const log = logger.child({ module: 'upgrade-claims-smoke' });

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

async function main(): Promise<void> {
  initDatabase(process.env.DATABASE_URL!);
  const db = getDb();
  const userId = randomUUID();
  const repositoryId = randomUUID();
  const now = new Date();
  const repoPath = await mkdtemp(join(tmpdir(), 'upgrade-claims-smoke-'));

  try {
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'upgrade-claims-smoke',
      emailBlindIndex: `upgrade-claims-smoke-${randomBytes(6).toString('hex')}`,
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
      label: 'upgrade-claims-smoke',
      rulesContent: 'Keep every change small.',
    });
    await db.insert(schema.repositories).values({
      id: repositoryId,
      userId,
      name: 'upgrade-claims-smoke',
      source: 'blank',
      createdAt: now,
      updatedAt: now,
    });

    // A blank repository is seeded with no artifact rows, so its first upgrade runs the backfill.
    const seeded = await seedBlankScaffold(
      db,
      { userId, repositoryId, repoName: 'upgrade-claims-smoke' },
      repoPath,
    );
    const [edited, overwritten, keptEdit] = seeded.filter((p) => p.endsWith('.md'));
    const untouched = seeded.find((p) => p !== edited && p !== overwritten && p !== keptEdit);
    if (!edited || !overwritten || !keptEdit || !untouched) {
      throw new Error(`scaffold wrote too little: ${seeded.join(', ')}`);
    }
    const editedBytes = `${await readFile(join(repoPath, edited), 'utf8')}\nEdited by hand.\n`;
    await writeFile(join(repoPath, edited), editedBytes);
    const overwrittenBytes = `${await readFile(join(repoPath, overwritten), 'utf8')}\nAlso edited.\n`;
    await writeFile(join(repoPath, overwritten), overwrittenBytes);
    const keptBytes = `${await readFile(join(repoPath, keptEdit), 'utf8')}\nKept by hand.\n`;
    await writeFile(join(repoPath, keptEdit), keptBytes);
    const untouchedBytes = await readFile(join(repoPath, untouched), 'utf8');
    // Removed before the first plan, so nothing stands there until the upgrade writes it.
    const removedBefore = seeded.filter((p) => p.endsWith('.md')).at(-1);
    if (!removedBefore || [edited, overwritten, keptEdit, untouched].includes(removedBefore)) {
      throw new Error(`scaffold wrote too little: ${seeded.join(', ')}`);
    }
    await rm(join(repoPath, removedBefore));
    const handRegion = `${CLI_RULES_START}\nOur own rule, written by hand.\n${CLI_RULES_END}`;
    await writeFile(join(repoPath, CLI_RULES_DISK_PATH), `# Project\n\n${handRegion}\n`);

    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId,
        type: 'onboarding_upgrade',
        title: 'upgrade-claims-smoke',
        status: 'running',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: schema.tasks.id });
    const taskId = task!.id;
    const [planRow, applyRow] = await db
      .insert(schema.taskSteps)
      .values([
        {
          taskId,
          stepId: '01-upgrade-plan',
          stepIndex: 1,
          title: 'Plan upgrade',
          status: 'running',
        },
        {
          taskId,
          stepId: '02-upgrade-apply',
          stepIndex: 2,
          title: 'Apply upgrade',
          status: 'pending',
        },
      ])
      .returning({ id: schema.taskSteps.id });

    const readOrNull = (rel: string) =>
      readFile(join(repoPath, rel), 'utf8').then(
        (text) => text,
        () => null,
      );
    const liveRowsAt = (rel: string) =>
      db
        .select()
        .from(schema.onboardingArtifacts)
        .where(
          and(
            eq(schema.onboardingArtifacts.repositoryId, repositoryId),
            eq(schema.onboardingArtifacts.diskPath, rel),
            isNull(schema.onboardingArtifacts.supersededAt),
          ),
        );

    const controller = new AbortController();
    const ctxFor = (taskStepId: string, forTask = taskId): StepContext => ({
      round: 0,
      taskId: forTask,
      taskStepId,
      userId,
      repoPath,
      workspacePath: repoPath,
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

    // ---- 01: plan and backfill ----------------------------------------------------------
    const planCtx = ctxFor(planRow!.id);
    const detected = await upgradePlanStep.detect!(planCtx);
    const bucketOf = (path: string) => detected.entries.find((e) => e.diskPath === path)?.bucket;
    check('the plan ran the backfill', detected.ranBackfill === true);
    check('an edited file is offered, not pre-selected', bucketOf(edited) === 'conflict', {
      bucket: bucketOf(edited),
    });
    check('an untouched file is adopted', bucketOf(untouched) === 'new_artifact', {
      bucket: bucketOf(untouched),
    });
    check(
      'a hand-written rules region is a conflict',
      bucketOf(CLI_RULES_DISK_PATH) === 'conflict',
      {
        bucket: bucketOf(CLI_RULES_DISK_PATH),
      },
    );

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
    const rowsAt = (path: string) =>
      db
        .select({ id: schema.onboardingArtifacts.id })
        .from(schema.onboardingArtifacts)
        .where(
          and(
            eq(schema.onboardingArtifacts.repositoryId, repositoryId),
            eq(schema.onboardingArtifacts.diskPath, path),
          ),
        );
    check('the backfill records no row for an offered edit', (await rowsAt(edited)).length === 0);
    check('nor for the hand-written region', (await rowsAt(CLI_RULES_DISK_PATH)).length === 0);
    check('but adopts the untouched file', (await rowsAt(untouched)).length === 1);
    check(
      'and records nothing for a file missing from disk',
      (await rowsAt(removedBefore)).length === 0,
    );

    // ---- 02: defaults, "overwrite" on the rules region and one file, one adoption declined -
    const applyCtx = ctxFor(applyRow!.id);
    const plan = await upgradeApplyStep.detect!(applyCtx);
    const form = upgradeApplyStep.form!(applyCtx, plan) as FormSchema | null;
    const values = defaultValues(form);
    const rulesField = form?.fields.find(
      (f) => f.type === 'radio' && f.label === `Conflict: ${CLI_RULES_DISK_PATH}`,
    );
    if (!rulesField) throw new Error('no conflict field for the rules region');
    values[rulesField.id] = 'apply_theirs';
    const overwriteField = form?.fields.find(
      (f) => f.type === 'radio' && f.label === `Conflict: ${overwritten}`,
    );
    if (!overwriteField) throw new Error(`no conflict field for ${overwritten}`);
    values[overwriteField.id] = 'apply_theirs';
    const keepField = form?.fields.find(
      (f) => f.type === 'radio' && f.label === `Conflict: ${keptEdit}`,
    );
    if (!keepField) throw new Error(`no conflict field for ${keptEdit}`);
    values[keepField.id] = 'keep_ours';
    // Its backfill row stays live under this task, and a rollback must not read it as a new file.
    const untouchedId = detected.entries.find((e) => e.diskPath === untouched)!.entryId;
    values.selectedNew = (values.selectedNew as string[]).filter((id) => id !== untouchedId);
    const applied = await upgradeApplyStep.apply(applyCtx, {
      detected: plan,
      formValues: values,
      iteration: 0,
      previousIterations: [],
    });
    await db
      .update(schema.taskSteps)
      .set({ output: applied as unknown as Record<string, unknown>, status: 'done' })
      .where(eq(schema.taskSteps.id, applyRow!.id));
    check('the missing file is written as new', (await readOrNull(removedBefore)) !== null);

    check(
      'the edited file is left as it was',
      (await readFile(join(repoPath, edited), 'utf8')) === editedBytes,
    );
    const keptEntry = detected.entries.find((e) => e.diskPath === keptEdit)!;
    const [keptRow] = await liveRowsAt(keptEdit);
    check(
      '"Keep my edits" records the version declined, and claims nothing',
      keptRow?.templateContentHash === keptEntry.currentTemplateContentHash &&
        keptRow?.writtenHash === keptEntry.newContentHash &&
        keptRow?.writtenContent === keptBytes &&
        (await readOrNull(keptEdit)) === keptBytes,
      { row: keptRow ?? null, render: keptEntry.newContentHash },
    );

    // ---- the next upgrade, and a rollback of this one -----------------------------------
    const again = await upgradePlanStep.detect!(planCtx);
    const againBucket = again.entries.find((e) => e.diskPath === edited)?.bucket;
    check('the next upgrade offers the skipped edit again', againBucket === 'conflict', {
      bucket: againBucket,
    });
    const keptAgain = again.entries.find((e) => e.diskPath === keptEdit)?.bucket;
    check('but not the kept one', keptAgain === 'unchanged', { bucket: keptAgain });

    await db
      .update(schema.tasks)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(schema.tasks.id, taskId));
    const [rollbackTask] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId,
        type: 'onboarding_upgrade',
        title: 'upgrade-claims-smoke rollback',
        status: 'running',
        metadata: { mode: 'rollback' },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: schema.tasks.id });
    const [rollbackRow] = await db
      .insert(schema.taskSteps)
      .values({
        taskId: rollbackTask!.id,
        stepId: '04-upgrade-rollback',
        stepIndex: 4,
        title: 'Roll back upgrade',
        status: 'running',
      })
      .returning({ id: schema.taskSteps.id });
    const rollbackCtx = ctxFor(rollbackRow!.id, rollbackTask!.id);
    const rollback = await upgradeRollbackStep.detect!(rollbackCtx);
    const restoreOf = (path: string) => rollback.targets.find((t) => t.diskPath === path);
    const deletes = (path: string) => rollback.newArtifactsToUndo.some((u) => u.diskPath === path);

    const overwrittenEntry = detected.entries.find((e) => e.diskPath === overwritten)!;
    const replaced = restoreOf(overwritten);
    check(
      'a rollback restores the overwritten file',
      replaced?.priorWrittenContent === overwrittenBytes && !deletes(overwritten),
      { restore: replaced?.priorArtifactId ?? null, deletes: deletes(overwritten) },
    );
    check(
      'without claiming the file',
      replaced?.priorWrittenHash === overwrittenEntry.newContentHash,
      {
        writtenHash: replaced?.priorWrittenHash,
        render: overwrittenEntry.newContentHash,
      },
    );
    const rulesEntry = detected.entries.find((e) => e.diskPath === CLI_RULES_DISK_PATH)!;
    const region = restoreOf(CLI_RULES_DISK_PATH);
    check(
      'a rollback restores the replaced region',
      region?.priorWrittenContent?.includes('written by hand') === true &&
        !deletes(CLI_RULES_DISK_PATH),
    );
    check('without claiming the region', region?.priorWrittenHash === rulesEntry.newContentHash, {
      writtenHash: region?.priorWrittenHash,
      render: rulesEntry.newContentHash,
    });
    const [regionPrior] = region
      ? await db
          .select({ userModified: schema.onboardingArtifacts.userModified })
          .from(schema.onboardingArtifacts)
          .where(eq(schema.onboardingArtifacts.id, region.priorArtifactId))
      : [];
    check("and marked as a person's", regionPrior?.userModified === true);
    check('a rollback leaves the skipped edit alone', !restoreOf(edited) && !deletes(edited));

    await upgradeRollbackStep.apply(rollbackCtx, {
      detected: rollback,
      formValues: {},
      iteration: 0,
      previousIterations: [],
    });
    check(
      'the rollback puts the overwritten file back',
      (await readFile(join(repoPath, overwritten), 'utf8')) === overwrittenBytes,
    );
    check(
      'and leaves the skipped edit as it was',
      (await readFile(join(repoPath, edited), 'utf8')) === editedBytes,
    );
    check(
      'and a kept file',
      !restoreOf(keptEdit) && !deletes(keptEdit) && (await readOrNull(keptEdit)) === keptBytes,
    );
    check(
      'and a file the upgrade was told not to write',
      !restoreOf(untouched) &&
        !deletes(untouched) &&
        (await readOrNull(untouched)) === untouchedBytes,
      { restore: restoreOf(untouched)?.priorArtifactId ?? null, deletes: deletes(untouched) },
    );
    check(
      'and takes away a file missing before the upgrade',
      (await readOrNull(removedBefore)) === null,
      { restore: restoreOf(removedBefore)?.priorArtifactId ?? null },
    );
    const restored = await upgradePlanStep.detect!(planCtx);
    const bucketAfter = (path: string) => restored.entries.find((e) => e.diskPath === path)?.bucket;
    check(
      'the next upgrade offers the restored file again',
      bucketAfter(overwritten) === 'conflict',
      {
        bucket: bucketAfter(overwritten),
      },
    );
    check('and the restored region', bucketAfter(CLI_RULES_DISK_PATH) === 'conflict', {
      bucket: bucketAfter(CLI_RULES_DISK_PATH),
    });
    check('and the file taken away as new', bucketAfter(removedBefore) === 'new_artifact', {
      bucket: bucketAfter(removedBefore),
    });

    // ---- a second upgrade: two retired templates, and two files new to it ------------------
    const [fresh, freshEdited, freshLinked] = seeded.filter(
      (p) =>
        p.endsWith('.md') &&
        ![edited, overwritten, keptEdit, untouched, removedBefore, CLI_RULES_DISK_PATH].includes(p),
    );
    if (!fresh || !freshEdited || !freshLinked)
      throw new Error(`scaffold wrote too few files: ${seeded.join(', ')}`);
    for (const path of [fresh, freshEdited, freshLinked]) {
      await rm(join(repoPath, path));
      await db
        .delete(schema.onboardingArtifacts)
        .where(
          and(
            eq(schema.onboardingArtifacts.repositoryId, repositoryId),
            eq(schema.onboardingArtifacts.diskPath, path),
          ),
        );
    }
    // Files Haive wrote and a person edited since, whose template then changed: one kept, one
    // overwritten.
    const moveTemplate = (path: string) =>
      db
        .update(schema.onboardingArtifacts)
        .set({ templateContentHash: 'template-changed-since' })
        .where(
          and(
            eq(schema.onboardingArtifacts.repositoryId, repositoryId),
            eq(schema.onboardingArtifacts.diskPath, path),
            isNull(schema.onboardingArtifacts.supersededAt),
          ),
        );
    const [editedTracked, tracked, rewritten] = seeded.filter(
      (p) =>
        p.endsWith('.md') &&
        ![
          edited,
          overwritten,
          keptEdit,
          untouched,
          removedBefore,
          fresh,
          freshEdited,
          freshLinked,
          CLI_RULES_DISK_PATH,
        ].includes(p),
    );
    if (!editedTracked || !tracked || !rewritten) {
      throw new Error(`scaffold wrote too few files: ${seeded.join(', ')}`);
    }
    const editedTrackedBytes = `${await readFile(join(repoPath, editedTracked), 'utf8')}\nOurs.\n`;
    await writeFile(join(repoPath, editedTracked), editedTrackedBytes);
    await moveTemplate(editedTracked);
    const trackedBytes = `${await readFile(join(repoPath, tracked), 'utf8')}\nOur change.\n`;
    await writeFile(join(repoPath, tracked), trackedBytes);
    await moveTemplate(tracked);
    // A file deleted by hand where its row stays live, and one whose only rows an old reset
    // superseded, the newest holding an older version, while the file still holds the render.
    await rm(join(repoPath, untouched));
    const rewrittenBytes = await readFile(join(repoPath, rewritten), 'utf8');
    await db
      .update(schema.onboardingArtifacts)
      .set({ supersededAt: new Date(), writtenContent: '# An older version\n' })
      .where(
        and(
          eq(schema.onboardingArtifacts.repositoryId, repositoryId),
          eq(schema.onboardingArtifacts.diskPath, rewritten),
          isNull(schema.onboardingArtifacts.supersededAt),
        ),
      );
    const retired = (name: string) => `.claude/agents/${name}.md`;
    const retiredBytes = '# Retired\n\nHaive wrote this.\n';
    const retiredEditedBytes = `${retiredBytes}Edited since.\n`;
    const retiredHash = sha256Hex(normalizeContent(retiredBytes));
    await mkdir(join(repoPath, '.claude/agents'), { recursive: true });
    await writeFile(join(repoPath, retired('retired-gone')), retiredBytes);
    await writeFile(join(repoPath, retired('retired-kept')), retiredEditedBytes);
    await symlink('elsewhere.md', join(repoPath, retired('retired-linked')));
    await db.insert(schema.onboardingArtifacts).values(
      ['retired-gone', 'retired-kept', 'retired-linked'].map((name) => ({
        userId,
        repositoryId,
        taskId,
        diskPath: retired(name),
        templateId: `agent.${name}`,
        templateKind: 'agent',
        templateSchemaVersion: 1,
        templateContentHash: retiredHash,
        writtenHash: retiredHash,
        writtenContent: retiredBytes,
        lastObservedDiskHash: retiredHash,
        userModified: false,
        sourceStepId: '12-post-onboarding',
        source: 'onboarding' as const,
      })),
    );

    const [secondTask] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId,
        type: 'onboarding_upgrade',
        title: 'upgrade-claims-smoke second',
        status: 'running',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: schema.tasks.id });
    const [secondPlanRow, secondApplyRow] = await db
      .insert(schema.taskSteps)
      .values([
        {
          taskId: secondTask!.id,
          stepId: '01-upgrade-plan',
          stepIndex: 1,
          title: 'Plan upgrade',
          status: 'running',
        },
        {
          taskId: secondTask!.id,
          stepId: '02-upgrade-apply',
          stepIndex: 2,
          title: 'Apply upgrade',
          status: 'pending',
        },
      ])
      .returning({ id: schema.taskSteps.id });
    const secondPlanCtx = ctxFor(secondPlanRow!.id, secondTask!.id);
    const secondDetected = await upgradePlanStep.detect!(secondPlanCtx);
    const secondPlanned = await upgradePlanStep.apply(secondPlanCtx, {
      detected: secondDetected,
      formValues: {},
      iteration: 0,
      previousIterations: [],
    });
    await db
      .update(schema.taskSteps)
      .set({ output: secondPlanned as unknown as Record<string, unknown>, status: 'done' })
      .where(eq(schema.taskSteps.id, secondPlanRow!.id));
    const secondBucket = (path: string) =>
      secondDetected.entries.find((e) => e.diskPath === path)?.bucket;
    const buckets = {
      deleted: secondBucket(untouched),
      rewritten: secondBucket(rewritten),
      gone: secondBucket(retired('retired-gone')),
      kept: secondBucket(retired('retired-kept')),
      linked: secondBucket(retired('retired-linked')),
      fresh: secondBucket(fresh),
      freshEdited: secondBucket(freshEdited),
      freshLinked: secondBucket(freshLinked),
    };
    check(
      'the second plan retires the old files and adds the missing ones',
      buckets.deleted === 'user_deleted' &&
        buckets.rewritten === 'new_artifact' &&
        buckets.gone === 'obsolete' &&
        buckets.kept === 'obsolete' &&
        buckets.linked === 'obsolete' &&
        buckets.fresh === 'new_artifact' &&
        buckets.freshEdited === 'new_artifact' &&
        buckets.freshLinked === 'new_artifact',
      buckets,
    );

    const secondApplyCtx = ctxFor(secondApplyRow!.id, secondTask!.id);
    const secondPlan = await upgradeApplyStep.detect!(secondApplyCtx);
    const secondForm = upgradeApplyStep.form!(secondApplyCtx, secondPlan) as FormSchema | null;
    const secondValues = defaultValues(secondForm);
    const keepTracked = secondForm?.fields.find(
      (f) => f.type === 'radio' && f.label === `Conflict: ${overwritten}`,
    );
    if (!keepTracked) throw new Error(`no conflict field for ${overwritten} in the second upgrade`);
    secondValues[keepTracked.id] = 'keep_ours';
    const keepEdited = secondForm?.fields.find(
      (f) => f.type === 'radio' && f.label === `Conflict: ${editedTracked}`,
    );
    if (!keepEdited) throw new Error(`no conflict field for ${editedTracked}`);
    secondValues[keepEdited.id] = 'keep_ours';
    const overwriteTracked = secondForm?.fields.find(
      (f) => f.type === 'radio' && f.label === `Conflict: ${tracked}`,
    );
    if (!overwriteTracked) throw new Error(`no conflict field for ${tracked}`);
    secondValues[overwriteTracked.id] = 'apply_theirs';
    secondValues.selectedObsoleteRemovals = secondDetected.entries
      .filter((e) => e.bucket === 'obsolete')
      .map((e) => e.entryId);
    secondValues.selectedReinstate = secondDetected.entries
      .filter((e) => e.diskPath === untouched)
      .map((e) => e.entryId);
    const secondApplied = await upgradeApplyStep.apply(secondApplyCtx, {
      detected: secondPlan,
      formValues: secondValues,
      iteration: 0,
      previousIterations: [],
    });
    await db
      .update(schema.taskSteps)
      .set({ output: secondApplied as unknown as Record<string, unknown>, status: 'done' })
      .where(eq(schema.taskSteps.id, secondApplyRow!.id));
    check('the deleted file is reinstated', (await readOrNull(untouched)) === untouchedBytes);
    check(
      'an obsolete file still holding what Haive wrote is deleted',
      (await readOrNull(retired('retired-gone'))) === null,
    );
    check(
      'an obsolete file edited since is kept, and said so',
      (await readOrNull(retired('retired-kept'))) === retiredEditedBytes &&
        secondApplied.warnings.some((w) => w.startsWith(`kept ${retired('retired-kept')}:`)),
      secondApplied.warnings,
    );
    check('and its row stays live', (await liveRowsAt(retired('retired-kept'))).length === 1);
    check(
      'an obsolete path a link now stands at is kept, and said so',
      (await lstat(join(repoPath, retired('retired-linked')))).isSymbolicLink() &&
        secondApplied.warnings.some((w) => w.startsWith(`kept ${retired('retired-linked')}:`)),
      secondApplied.warnings,
    );
    check('and its row stays live too', (await liveRowsAt(retired('retired-linked'))).length === 1);
    const [editedTrackedRow] = await liveRowsAt(editedTracked);
    check(
      'a tracked file kept holds the bytes kept, for a later rollback',
      editedTrackedRow?.writtenContent === editedTrackedBytes &&
        editedTrackedRow?.writtenHash !== sha256Hex(normalizeContent(editedTrackedBytes)),
      { writtenContent: editedTrackedRow?.writtenContent?.slice(-40) ?? null },
    );
    const third = await upgradePlanStep.detect!(secondPlanCtx);
    const keptTracked = third.entries.find((e) => e.diskPath === overwritten)?.bucket;
    check('"Keep my edits" on a tracked file stops the offer too', keptTracked === 'unchanged', {
      bucket: keptTracked,
    });

    // ---- a rollback of the second upgrade, one new file edited since -----------------------
    const freshEditedBytes = `${await readFile(join(repoPath, freshEdited), 'utf8')}Edited after.\n`;
    await writeFile(join(repoPath, freshEdited), freshEditedBytes);
    await rm(join(repoPath, freshLinked));
    await symlink('elsewhere.md', join(repoPath, freshLinked));
    await db
      .update(schema.tasks)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(schema.tasks.id, secondTask!.id));
    const [secondRollbackTask] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId,
        type: 'onboarding_upgrade',
        title: 'upgrade-claims-smoke second rollback',
        status: 'running',
        metadata: { mode: 'rollback' },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: schema.tasks.id });
    const [secondRollbackRow] = await db
      .insert(schema.taskSteps)
      .values({
        taskId: secondRollbackTask!.id,
        stepId: '04-upgrade-rollback',
        stepIndex: 4,
        title: 'Roll back upgrade',
        status: 'running',
      })
      .returning({ id: schema.taskSteps.id });
    const secondRollbackCtx = ctxFor(secondRollbackRow!.id, secondRollbackTask!.id);
    const secondRollback = await upgradeRollbackStep.detect!(secondRollbackCtx);
    const undoes = secondRollback.newArtifactsToUndo.map((u) => u.diskPath);
    check(
      'the rollback plans to undo every new file',
      undoes.includes(fresh) && undoes.includes(freshEdited) && undoes.includes(freshLinked),
      undoes,
    );
    const secondRolledBack = await upgradeRollbackStep.apply(secondRollbackCtx, {
      detected: secondRollback,
      formValues: {},
      iteration: 0,
      previousIterations: [],
    });
    check('an unedited new file is removed', (await readOrNull(fresh)) === null);
    check(
      'an overwritten edit to a tracked file is put back',
      (await readOrNull(tracked)) === trackedBytes,
    );
    check(
      'a new file edited since is kept, and said so',
      (await readOrNull(freshEdited)) === freshEditedBytes &&
        secondRolledBack.warnings.some((w) => w.startsWith(`kept ${freshEdited}:`)),
      secondRolledBack.warnings,
    );
    check(
      'a link standing in for a new file is kept, and said so',
      (await lstat(join(repoPath, freshLinked))).isSymbolicLink() &&
        secondRolledBack.warnings.some((w) => w.startsWith(`kept ${freshLinked}:`)),
      secondRolledBack.warnings,
    );
    const upgradeRowsLive = async (rel: string) =>
      (await liveRowsAt(rel)).filter((r) => r.source === 'upgrade').length;
    check(
      "and the upgrade's rows at both are retired",
      (await upgradeRowsLive(freshEdited)) === 0 && (await upgradeRowsLive(freshLinked)) === 0,
    );
    check(
      'a reinstated file is taken away again',
      (await readOrNull(untouched)) === null,
      secondRollback.targets.find((t) => t.diskPath === untouched)?.priorArtifactId ?? null,
    );
    const afterSecond = await upgradePlanStep.detect!(secondPlanCtx);
    const bucketAfterSecond = (path: string) =>
      afterSecond.entries.find((e) => e.diskPath === path)?.bucket;
    check('and reads as deleted again', bucketAfterSecond(untouched) === 'user_deleted', {
      bucket: bucketAfterSecond(untouched),
    });
    check(
      'a file the upgrade rewrote with the bytes it held keeps them',
      (await readOrNull(rewritten)) === rewrittenBytes &&
        (await liveRowsAt(rewritten)).length === 0,
      { onDisk: (await readOrNull(rewritten))?.slice(0, 40) ?? null },
    );
    check('and reads as new again', bucketAfterSecond(rewritten) === 'new_artifact', {
      bucket: bucketAfterSecond(rewritten),
    });

    // ---- the boot repair ----------------------------------------------------------------
    const h = (c: string) => c.repeat(64);
    const row = (over: Partial<typeof schema.onboardingArtifacts.$inferInsert>) =>
      ({
        userId,
        repositoryId,
        taskId,
        templateId: 'agent.smoke',
        templateKind: 'agent',
        templateSchemaVersion: 1,
        sourceStepId: 'upgrade-claims-smoke',
        ...over,
      }) as typeof schema.onboardingArtifacts.$inferInsert;
    const [preFix, copy, rules, postFix] = await db
      .insert(schema.onboardingArtifacts)
      .values([
        row({
          diskPath: 'smoke/pre.md',
          source: 'backfill',
          userModified: true,
          writtenHash: h('a'),
          lastObservedDiskHash: h('a'),
          templateContentHash: h('b'),
          supersededAt: now,
        }),
        row({
          diskPath: 'smoke/pre.md',
          source: 'rollback',
          writtenHash: h('a'),
          lastObservedDiskHash: h('a'),
          templateContentHash: h('b'),
        }),
        row({
          diskPath: 'smoke/AGENTS.md',
          templateKind: CLI_RULES_TEMPLATE_KIND,
          source: 'backfill',
          userModified: true,
          writtenHash: h('c'),
          lastObservedDiskHash: h('c'),
          templateContentHash: h('d'),
        }),
        row({
          diskPath: 'smoke/post.md',
          source: 'backfill',
          userModified: true,
          writtenHash: h('e'),
          lastObservedDiskHash: h('f'),
          templateContentHash: h('f'),
        }),
      ])
      .returning({ id: schema.onboardingArtifacts.id });
    const ours = new Set([preFix!.id, copy!.id, rules!.id, postFix!.id]);
    if (replaced) ours.add(replaced.priorArtifactId);
    const hashesOf = async (id: string) =>
      (
        await db
          .select({
            writtenHash: schema.onboardingArtifacts.writtenHash,
            templateContentHash: schema.onboardingArtifacts.templateContentHash,
          })
          .from(schema.onboardingArtifacts)
          .where(eq(schema.onboardingArtifacts.id, id))
      )[0];
    const hashOf = async (id: string) => (await hashesOf(id))?.writtenHash;

    const first = (await unclaimBackfilledEdits(db)).filter((id) => ours.has(id));
    check(
      'the repair takes back the claim and its rollback copy',
      first.length === 2 && first.includes(preFix!.id) && first.includes(copy!.id),
      first,
    );
    const unresolved = async (id: string) => {
      const row = await hashesOf(id);
      return row?.writtenHash === h('b') && row.templateContentHash === h('a');
    };
    check(
      'each now claims neither the bytes nor the template',
      (await unresolved(preFix!.id)) && (await unresolved(copy!.id)),
      { preFix: await hashesOf(preFix!.id), copy: await hashesOf(copy!.id) },
    );
    check('a rules row is left alone', (await hashOf(rules!.id)) === h('c'));
    check('a row the fix wrote is left alone', (await hashOf(postFix!.id)) === h('e'));
    check(
      'the baseline 02 kept is left alone',
      replaced !== undefined &&
        (await hashOf(replaced.priorArtifactId)) === overwrittenEntry.newContentHash,
    );
    const second = (await unclaimBackfilledEdits(db)).filter((id) => ours.has(id));
    check('a second run changes nothing', second.length === 0, second);

    if (failures > 0) {
      log.error({ failures, checks }, 'smoke FAILED');
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify({ smoke: 'UPGRADE_CLAIMS_OK', checks }));
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
