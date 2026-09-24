/**
 * The real 01/02 upgrade steps and the boot repair, against a database and a seeded blank repository
 * holding one edited file and one hand-written AGENTS.md region. One throwaway user, deleted after.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, isNotNull } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  CLI_RULES_DISK_PATH,
  CLI_RULES_END,
  CLI_RULES_START,
  CLI_RULES_TEMPLATE_KIND,
  logger,
  type FormSchema,
} from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import { unclaimBackfilledEdits } from '../src/data-migrations.js';
import { seedBlankScaffold } from '../src/repo/blank-scaffold.js';
import { TaskCancelledError, type StepContext } from '../src/step-engine/step-definition.js';
import { upgradePlanStep } from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import { upgradeApplyStep } from '../src/step-engine/steps/onboarding-upgrade/02-upgrade-apply.js';

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
    const [edited, overwritten] = seeded.filter((p) => p.endsWith('.md'));
    const untouched = seeded.find((p) => p !== edited && p !== overwritten);
    if (!edited || !overwritten || !untouched) {
      throw new Error(`scaffold wrote too little: ${seeded.join(', ')}`);
    }
    const editedBytes = `${await readFile(join(repoPath, edited), 'utf8')}\nEdited by hand.\n`;
    await writeFile(join(repoPath, edited), editedBytes);
    const overwrittenBytes = `${await readFile(join(repoPath, overwritten), 'utf8')}\nAlso edited.\n`;
    await writeFile(join(repoPath, overwritten), overwrittenBytes);
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

    const controller = new AbortController();
    const ctxFor = (taskStepId: string): StepContext => ({
      round: 0,
      taskId,
      taskStepId,
      userId,
      repoPath,
      workspacePath: repoPath,
      sandboxWorkdir: '/haive/workdir',
      cliProviderId: null,
      db,
      logger: log,
      signal: controller.signal,
      throwIfCancelled: () => {
        if (controller.signal.aborted) throw new TaskCancelledError();
      },
      async emitProgress() {},
    });

    // ---- 01: plan and backfill ----------------------------------------------------------
    const planCtx = ctxFor(planRow!.id);
    const detected = await upgradePlanStep.detect(planCtx);
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

    const planned = await upgradePlanStep.apply(planCtx, { detected, formValues: {} });
    await db
      .update(schema.taskSteps)
      .set({ output: planned as unknown as Record<string, unknown>, status: 'done' })
      .where(eq(schema.taskSteps.id, planRow!.id));
    const editedEntry = detected.entries.find((e) => e.diskPath === edited)!;
    const [editedRow] = await db
      .select()
      .from(schema.onboardingArtifacts)
      .where(
        and(
          eq(schema.onboardingArtifacts.repositoryId, repositoryId),
          eq(schema.onboardingArtifacts.diskPath, edited),
        ),
      );
    check(
      'the backfill claims the render, not the edit',
      editedRow?.writtenHash === editedEntry.newContentHash,
      {
        writtenHash: editedRow?.writtenHash,
        render: editedEntry.newContentHash,
        disk: editedEntry.currentHash,
      },
    );
    check('the backfill keeps the edited bytes', editedRow?.writtenContent === editedBytes);
    check('the backfill marks the file edited', editedRow?.userModified === true);

    // ---- 02: defaults, plus "overwrite" on the rules region ------------------------------
    const applyCtx = ctxFor(applyRow!.id);
    const plan = await upgradeApplyStep.detect(applyCtx);
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
    await upgradeApplyStep.apply(applyCtx, { detected: plan, formValues: values });

    check(
      'the edited file is left as it was',
      (await readFile(join(repoPath, edited), 'utf8')) === editedBytes,
    );
    const [baseline] = await db
      .select()
      .from(schema.onboardingArtifacts)
      .where(
        and(
          eq(schema.onboardingArtifacts.repositoryId, repositoryId),
          eq(schema.onboardingArtifacts.diskPath, CLI_RULES_DISK_PATH),
          eq(schema.onboardingArtifacts.source, 'backfill'),
          isNotNull(schema.onboardingArtifacts.supersededAt),
        ),
      );
    const rulesEntry = detected.entries.find((e) => e.diskPath === CLI_RULES_DISK_PATH)!;
    check(
      'the replaced region is kept for a rollback',
      baseline?.writtenContent?.includes('written by hand') === true,
    );
    check('but not claimed as a render', baseline?.writtenHash === rulesEntry.newContentHash, {
      writtenHash: baseline?.writtenHash,
      render: rulesEntry.newContentHash,
    });
    check("and marked as a person's", baseline?.userModified === true);

    const overwrittenEntry = detected.entries.find((e) => e.diskPath === overwritten)!;
    const [replaced] = await db
      .select()
      .from(schema.onboardingArtifacts)
      .where(
        and(
          eq(schema.onboardingArtifacts.repositoryId, repositoryId),
          eq(schema.onboardingArtifacts.diskPath, overwritten),
          eq(schema.onboardingArtifacts.sourceStepId, '02-upgrade-apply'),
          isNotNull(schema.onboardingArtifacts.supersededAt),
        ),
      );
    check(
      'an overwritten file is kept for a rollback',
      replaced?.writtenContent === overwrittenBytes,
    );
    check(
      'but not claimed as a render',
      replaced?.writtenHash === overwrittenEntry.newContentHash,
      {
        writtenHash: replaced?.writtenHash,
        render: overwrittenEntry.newContentHash,
      },
    );

    // ---- the next template change -------------------------------------------------------
    await db
      .update(schema.onboardingArtifacts)
      .set({ templateContentHash: 'template-changed-since' })
      .where(eq(schema.onboardingArtifacts.id, editedRow!.id));
    const next = await upgradePlanStep.detect(planCtx);
    const nextBucket = next.entries.find((e) => e.diskPath === edited)?.bucket;
    check('a later template change leaves the edit a conflict', nextBucket === 'conflict', {
      bucket: nextBucket,
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
          templateContentHash: h('0'),
        }),
      ])
      .returning({ id: schema.onboardingArtifacts.id });
    const ours = new Set([preFix!.id, copy!.id, rules!.id, postFix!.id, editedRow!.id]);
    const hashOf = async (id: string) =>
      (
        await db
          .select({ writtenHash: schema.onboardingArtifacts.writtenHash })
          .from(schema.onboardingArtifacts)
          .where(eq(schema.onboardingArtifacts.id, id))
      )[0]?.writtenHash;

    const first = (await unclaimBackfilledEdits(db)).filter((id) => ours.has(id));
    check(
      'the repair takes back the claim and its rollback copy',
      first.length === 2 && first.includes(preFix!.id) && first.includes(copy!.id),
      first,
    );
    check(
      'each now holds the render sentinel',
      (await hashOf(preFix!.id)) === h('b') && (await hashOf(copy!.id)) === h('b'),
    );
    check('a rules row is left alone', (await hashOf(rules!.id)) === h('c'));
    check('a row the fix wrote is left alone', (await hashOf(postFix!.id)) === h('e'));
    check(
      'the live backfill row is left alone',
      (await hashOf(editedRow!.id)) === editedEntry.newContentHash,
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
