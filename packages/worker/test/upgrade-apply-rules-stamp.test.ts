import { mkdtemp, readFile, rm, writeFile, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  CLI_RULES_END,
  CLI_RULES_START,
  CLI_RULES_TEMPLATE_KIND,
  CLI_RULES_SCHEMA_VERSION,
  buildRepoCliRulesBlock,
  extractRegion,
  logger,
  normalizeContent,
  sha256Hex,
} from '@haive/shared';
import { isRenderContextSnapshot } from '@haive/shared/project-state';
import type { StepContext } from '../src/step-engine/step-definition.js';
import type {
  UpgradePlanEntry,
  UpgradePlanOutput,
} from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import { upgradeApplyStep } from '../src/step-engine/steps/onboarding-upgrade/02-upgrade-apply.js';
import { REFERENCE_CONTEXT } from '../src/step-engine/template-manifest.js';
import { refreshProjectState } from '../src/project-state/refresh.js';
import { resyncAfterTaskEnd } from '../src/project-state/set-aside.js';
import { syncProjectStateFromCheckout } from '../src/project-state/sync.js';
import * as importedRules from '../src/project-state/task-end-rules.js';
import { classifyEntry } from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import type { LiveArtifactRow } from '../src/step-engine/_upgrade-render.js';
import { RECORD_WRITE_TABLES, recordWritten } from './support/upgrade-apply-record.js';

// 02 writes the region from the plan's `newContent` and never renders it again, so a form that parked
// across a change of the repository's rules override would write a region nobody approved. 01 stamps
// the plan with the override it read, and 02 refuses a plan whose stamp is no longer the column's.

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000c1';

const REGION = `${CLI_RULES_START}\nPLANNED RULES\n${CLI_RULES_END}`;
const ENTRY_ID = 'e:AGENTS.md';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const entry: UpgradePlanEntry = {
  entryId: ENTRY_ID,
  bucket: 'new_artifact',
  templateId: 'cli-rules',
  templateKind: CLI_RULES_TEMPLATE_KIND,
  diskPath: 'AGENTS.md',
  liveArtifactId: null,
  currentContent: null,
  newContent: REGION,
  baselineContent: null,
  currentHash: null,
  baselineWrittenHash: null,
  newContentHash: sha256Hex(normalizeContent(REGION)),
  baselineTemplateContentHash: null,
  currentTemplateContentHash: sha256Hex(normalizeContent(REGION)),
  templateSchemaVersion: 2,
  delta: null,
};

/** A plan that writes AGENTS.md, stamped with `stamp` (absent when undefined), applied against a
 *  repository whose rules override is `live`. */
async function setup(stamp: string | null | undefined, live: string | null) {
  const root = await mkdtemp(join(tmpdir(), 'upgrade-apply-rules-stamp-'));
  dirs.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  const fake = createFakeDb({
    auditEvents: schema.auditEvents,
    taskSteps: schema.taskSteps,
    onboardingArtifacts: schema.onboardingArtifacts,
    repositories: schema.repositories,
    customBundles: schema.customBundles,
    customBundleItems: schema.customBundleItems,
    cliProviders: schema.cliProviders,
    planNodes: schema.planNodes,
    planMirrorState: schema.planMirrorState,
    ...RECORD_WRITE_TABLES,
  });
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'acme',
    source: 'blank',
    storagePath: root,
    agentRulesOverride: live,
  });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    repositoryId: REPO,
    type: 'onboarding_upgrade',
    status: 'running',
  });
  const plan = {
    repositoryId: REPO,
    ranBackfill: false,
    entries: [entry],
    counts: {
      unchanged: 0,
      clean_update: 0,
      adopt: 0,
      conflict: 0,
      new_artifact: 1,
      user_deleted: 0,
      obsolete: 0,
      foreign: 0,
    },
    installedTemplateSetHash: null,
    currentTemplateSetHash: 'set',
    renderCtxSnapshot: REFERENCE_CONTEXT as unknown as Record<string, unknown>,
    ...(stamp === undefined ? {} : { agentRulesOverride: stamp }),
    backfilledRows: 0,
  } as UpgradePlanOutput;
  const noop = () => undefined;
  const ctx = {
    db: fake.db,
    repoPath: root,
    taskId: TASK,
    userId: USER,
    throwIfCancelled: () => {},
    logger: { info: noop, warn: noop, error: noop, debug: noop },
  } as unknown as StepContext;
  const apply = () =>
    upgradeApplyStep.apply(ctx, {
      detected: plan,
      formValues: { selectedNew: [ENTRY_ID] },
      iteration: 0,
      previousIterations: [],
    });
  const agentsMd = () => readFile(join(root, 'AGENTS.md'), 'utf8');
  return { fake, apply, agentsMd, root };
}

describe('02 and the rules override its plan was made from', () => {
  it.each(
    (['IMPORTED RULES\n', '', null] as const).flatMap((incoming) =>
      (['task-end', 'refresh', 'direct'] as const).map((importer) => [incoming, importer] as const),
    ),
  )(
    'defers an imported override %j through the record write and a retry, then imports via %s',
    async (incoming, importer) => {
      const local = 'PLANNED RULES\n';
      const s = await setup(local, local);
      await recordWritten(s.apply());
      Object.assign(s.fake.rows(schema.repositories)[0]!, {
        renderContext: { ...REFERENCE_CONTEXT, rtkEnabled: true, rtkChoiceRecorded: false },
        rtkChoiceMadeAt: null,
      });
      const path = join(s.root, '.haive-data/state/settings/agent-rules.md');
      if (incoming === null) await unlink(path);
      else await writeFile(path, incoming);

      const output = await s.apply();

      expect(s.fake.rows(schema.repositories)[0]!.agentRulesOverride).toBe(local);
      expect(output.recordWrite).toBe('deferred');
      expect(output.warnings).toContain(
        'Project state record deferred: imported repository rules are waiting for this upgrade to finish',
      );
      if (incoming === null) await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
      else expect(await readFile(path, 'utf8')).toBe(incoming);
      expect((await s.apply()).recordWrite).toBe('deferred');
      expect(await s.agentsMd()).toContain('PLANNED RULES');

      s.fake.patch(schema.tasks, TASK, { status: 'completed' });
      if (importer === 'refresh') await refreshProjectState(s.fake.db as unknown as Database, REPO);
      if (importer === 'direct')
        await syncProjectStateFromCheckout(s.fake.db as unknown as Database, {
          repositoryId: REPO,
          repoPath: s.root,
        });
      if (importer !== 'task-end') {
        const expected = buildRepoCliRulesBlock(incoming);
        expect(extractRegion(await s.agentsMd(), CLI_RULES_START, CLI_RULES_END)).toBe(
          expected === null ? null : extractRegion(expected, CLI_RULES_START, CLI_RULES_END),
        );
      }
      await resyncAfterTaskEnd(s.fake.db as unknown as Database, TASK);

      expect(s.fake.rows(schema.repositories)[0]!.agentRulesOverride).toBe(incoming);
      const render = buildRepoCliRulesBlock(incoming);
      const region = extractRegion(await s.agentsMd(), CLI_RULES_START, CLI_RULES_END);
      const live = s.fake
        .rows(schema.onboardingArtifacts)
        .filter((row) => row.diskPath === 'AGENTS.md' && row.supersededAt == null);
      if (render === null) {
        expect(live).toEqual([]);
      } else {
        const hash = sha256Hex(normalizeContent(render));
        // upgrade-status compares these same schema/hash fields against the shared renderer.
        expect(live).toHaveLength(1);
        expect(isRenderContextSnapshot(live[0]!.formValuesSnapshot)).toBe(true);
        // No RTK choice was made, so the snapshot records no RTK value.
        expect(live[0]!.formValuesSnapshot).not.toHaveProperty('rtkEnabled');
        expect(
          classifyEntry({
            live: live[0] as unknown as LiveArtifactRow,
            current: {
              templateId: 'cli-rules',
              templateKind: CLI_RULES_TEMPLATE_KIND,
              templateSchemaVersion: CLI_RULES_SCHEMA_VERSION,
              templateContentHash: hash,
              diskPath: 'AGENTS.md',
              content: render,
              writtenHash: hash,
            },
            diskHash: region === null ? null : sha256Hex(normalizeContent(region)),
          }),
        ).toBe('unchanged');
        expect(live[0]).toMatchObject({
          templateSchemaVersion: CLI_RULES_SCHEMA_VERSION,
          templateContentHash: hash,
          writtenHash: hash,
          writtenContent: region,
        });
      }
      expect(region).toBe(
        render === null ? null : extractRegion(render, CLI_RULES_START, CLI_RULES_END),
      );
      const settledRows = structuredClone(s.fake.rows(schema.onboardingArtifacts));
      const settledFile = await s.agentsMd();
      await resyncAfterTaskEnd(s.fake.db as unknown as Database, TASK);
      expect(await s.agentsMd()).toBe(settledFile);
      expect(s.fake.rows(schema.onboardingArtifacts)).toEqual(settledRows);
    },
  );

  it('leaves AGENTS.md and its ledger byte-identical at task end without a deferred import', async () => {
    const s = await setup('PLANNED RULES\n', 'PLANNED RULES\n');
    await recordWritten(s.apply());
    const before = await s.agentsMd();
    const rows = structuredClone(s.fake.rows(schema.onboardingArtifacts));
    s.fake.patch(schema.tasks, TASK, { status: 'completed' });

    await resyncAfterTaskEnd(s.fake.db as unknown as Database, TASK);

    expect(await s.agentsMd()).toBe(before);
    expect(s.fake.rows(schema.onboardingArtifacts)).toEqual(rows);
  });

  it('clears a deferral whose incoming override was withdrawn, without rendering', async () => {
    const s = await setup('PLANNED RULES\n', 'PLANNED RULES\n');
    await recordWritten(s.apply());
    const path = join(s.root, '.haive-data/state/settings/agent-rules.md');
    await writeFile(path, 'TEAM RULES\n');
    expect((await s.apply()).recordWrite).toBe('deferred');
    await writeFile(path, 'PLANNED RULES\n');
    s.fake.patch(schema.tasks, TASK, { status: 'completed' });
    const rows = structuredClone(s.fake.rows(schema.onboardingArtifacts));

    await resyncAfterTaskEnd(s.fake.db as unknown as Database, TASK);

    expect(s.fake.rows(schema.projectStateOutbox)[0]!.rulesReconcileIntent).toBeNull();
    expect(s.fake.rows(schema.onboardingArtifacts)).toEqual(rows);
    expect(await s.agentsMd()).toContain('PLANNED RULES');
  });

  it('leaves an ordinary override import for the next upgrade when no import was deferred', async () => {
    const s = await setup('PLANNED RULES\n', 'PLANNED RULES\n');
    await recordWritten(s.apply());
    const before = await s.agentsMd();
    const rows = structuredClone(s.fake.rows(schema.onboardingArtifacts));
    await writeFile(join(s.root, '.haive-data/state/settings/agent-rules.md'), 'TEAM RULES\n');
    s.fake.patch(schema.tasks, TASK, { status: 'completed' });

    await syncProjectStateFromCheckout(s.fake.db as unknown as Database, {
      repositoryId: REPO,
      repoPath: s.root,
    });

    expect(s.fake.rows(schema.repositories)[0]!.agentRulesOverride).toBe('TEAM RULES\n');
    expect(await s.agentsMd()).toBe(before);
    expect(s.fake.rows(schema.onboardingArtifacts)).toEqual(rows);
  });

  it.each([
    [true, 'onboarding_upgrade'],
    [false, 'onboarding_upgrade'],
    [true, 'onboarding'],
  ] as const)(
    'preserves text outside the rules region at task end (outbox exists: %s, %s)',
    async (outboxExists, type) => {
      const s = await setup('PLANNED RULES\n', 'PLANNED RULES\n');
      s.fake.patch(schema.tasks, TASK, { type });
      await recordWritten(s.apply());
      if (!outboxExists)
        await s.fake.db
          .delete(schema.projectStateOutbox)
          .where(eq(schema.projectStateOutbox.repositoryId, REPO));
      await writeFile(
        join(s.root, 'AGENTS.md'),
        `# Project\n\n${await s.agentsMd()}\nUser notes\n`,
      );
      await writeFile(join(s.root, '.haive-data/state/settings/agent-rules.md'), 'TEAM RULES\n');
      s.fake.patch(schema.tasks, TASK, { status: 'completed' });

      await resyncAfterTaskEnd(s.fake.db as unknown as Database, TASK);

      expect(await s.agentsMd()).toContain('# Project\n\n');
      expect(await s.agentsMd()).toContain('TEAM RULES');
      expect(await s.agentsMd()).toContain('User notes\n');
    },
  );

  it.each(['holder', 'reset', 'journal', 'git', 'override', 'reset epoch', 'edited region'])(
    'preserves the region and ledger and settles the obligation when %s refuses the write',
    async (guard) => {
      const s = await setup('PLANNED RULES\n', 'PLANNED RULES\n');
      await recordWritten(s.apply());
      await writeFile(join(s.root, '.haive-data/state/settings/agent-rules.md'), 'TEAM RULES\n');
      s.fake.patch(schema.tasks, TASK, { status: 'completed' });
      const drain = vi
        .spyOn(importedRules, 'reconcileImportedRules')
        .mockResolvedValueOnce(undefined);
      const result = await syncProjectStateFromCheckout(s.fake.db as unknown as Database, {
        repositoryId: REPO,
        repoPath: s.root,
        endingTaskId: TASK,
      });
      drain.mockRestore();
      expect(result.outcome).toBe('applied');
      const owed = s.fake.rows(schema.projectStateOutbox)[0]!.rulesReconcileIntent;
      expect(owed).toMatchObject({
        phase: 'ready',
        before: 'PLANNED RULES\n',
        after: 'TEAM RULES\n',
      });
      if (guard === 'holder') s.fake.patch(schema.tasks, TASK, { status: 'running' });
      if (guard === 'reset')
        s.fake.patch(schema.repositories, REPO, {
          rootClaimKind: 'reset',
          rootClaimedAt: new Date(),
        });
      if (guard === 'journal')
        await s.fake.db
          .update(schema.projectStateOutbox)
          .set({ writeIntent: { pending: true } })
          .where(eq(schema.projectStateOutbox.repositoryId, REPO));
      if (guard === 'git') await writeFile(join(s.root, '.git/MERGE_HEAD'), 'a'.repeat(40) + '\n');
      if (guard === 'override')
        s.fake.patch(schema.repositories, REPO, { agentRulesOverride: 'NEWER RULES\n' });
      if (guard === 'reset epoch')
        s.fake.patch(schema.repositories, REPO, { onboardingResetAt: new Date() });
      if (guard === 'edited region')
        await writeFile(
          join(s.root, 'AGENTS.md'),
          REGION.replace('PLANNED RULES', 'PERSONAL EDIT'),
        );
      const before = await s.agentsMd();
      const rows = structuredClone(s.fake.rows(schema.onboardingArtifacts));
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const permanent = ['override', 'reset epoch', 'edited region'].includes(guard);
      try {
        await importedRules.reconcileImportedRules(s.fake.db as unknown as Database, REPO, s.root);
        expect(await s.agentsMd()).toBe(before);
        expect(s.fake.rows(schema.onboardingArtifacts)).toEqual(rows);
        expect(s.fake.rows(schema.projectStateOutbox)[0]!.rulesReconcileIntent).toEqual(
          permanent ? null : owed,
        );
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ repositoryId: REPO, taskId: TASK, err: expect.any(Error) }),
          permanent
            ? 'imported rules region not reconciled; left for the next upgrade'
            : 'imported rules region not reconciled; the next sweep will retry it',
        );
        if (permanent) {
          await importedRules.reconcileImportedRules(
            s.fake.db as unknown as Database,
            REPO,
            s.root,
          );
          expect(warn).toHaveBeenCalledTimes(1);
        }
        if (guard === 'journal') {
          await s.fake.db
            .update(schema.projectStateOutbox)
            .set({ writeIntent: null })
            .where(eq(schema.projectStateOutbox.repositoryId, REPO));
          await importedRules.reconcileImportedRules(
            s.fake.db as unknown as Database,
            REPO,
            s.root,
          );
          expect(await s.agentsMd()).toContain('TEAM RULES');
          expect(s.fake.rows(schema.projectStateOutbox)[0]!.rulesReconcileIntent).toBeNull();
          expect(warn).toHaveBeenCalledTimes(1);
        }
      } finally {
        warn.mockRestore();
      }
    },
  );

  it.each([
    ['one text for another', 'A', 'B'],
    ['NULL for the empty string', null, ''],
    ['the empty string for NULL', '', null],
    ['text for NULL', 'A', null],
  ])('refuses a plan stamped with %s, and writes nothing', async (_name, stamp, live) => {
    const s = await setup(stamp, live);

    await expect(s.apply()).rejects.toThrow('plan no longer holds');

    await expect(s.agentsMd()).rejects.toMatchObject({ code: 'ENOENT' });
    expect(s.fake.rows(schema.onboardingArtifacts)).toEqual([]);
  });

  it.each([
    ['the override the column holds', 'A', 'A'],
    ['NULL where the column is NULL', null, null],
    ['the empty string where the column is empty', '', ''],
    ['no stamp, as a plan from before it', undefined, 'B'],
  ])('applies a plan stamped with %s', async (_name, stamp, live) => {
    const s = await setup(stamp, live);

    const out = await recordWritten(s.apply());

    expect(out.warnings).toEqual([]);
    expect(await s.agentsMd()).toContain('PLANNED RULES');
    expect(s.fake.rows(schema.onboardingArtifacts).some((r) => r.diskPath === 'AGENTS.md')).toBe(
      true,
    );
  });
});
