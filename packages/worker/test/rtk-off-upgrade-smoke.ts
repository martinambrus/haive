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
import { logger, RTK_REF_MARKER_END, RTK_REF_MARKER_START, type FormSchema } from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import { seedBlankScaffold } from '../src/repo/blank-scaffold.js';
import { TaskCancelledError, type StepContext } from '../src/step-engine/step-definition.js';
import {
  upgradePlanStep,
  type UpgradePlanDetect,
} from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import { upgradeApplyStep } from '../src/step-engine/steps/onboarding-upgrade/02-upgrade-apply.js';
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
    const ctxFor = (taskId: string, taskStepId: string): StepContext => ({
      round: 0,
      taskId,
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
    async function upgrade(title: string) {
      const [task] = await db
        .insert(schema.tasks)
        .values({
          userId,
          repositoryId,
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
      const planCtx = ctxFor(task!.id, planRow!.id);
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
      const applyCtx = ctxFor(task!.id, applyRow!.id);
      const plan = await upgradeApplyStep.detect!(applyCtx);
      const form = upgradeApplyStep.form!(applyCtx, plan) as FormSchema | null;
      return { detected, form, applyCtx, plan };
    }
    const settingsEntry = (detected: UpgradePlanDetect) =>
      detected.entries.find((e) => e.diskPath === SETTINGS);

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
    check('an unedited settings file is removed', (await readOrNull(SETTINGS)) === null);
    check('and its row retired', (await liveRowsAt(SETTINGS)).length === 0);
    check(
      'the rules files are left alone',
      (await readOrNull('AGENTS.md')) === agentsMd &&
        (await readOrNull('CLAUDE.md')) === claudeMd &&
        !againApplied.writtenPaths?.includes('AGENTS.md'),
      againApplied.writtenPaths,
    );

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
