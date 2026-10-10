import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  normalizeContent,
  RTK_REF_MARKER_END,
  RTK_REF_MARKER_START,
  sha256Hex,
} from '@haive/shared';
import type { StepContext } from '../src/step-engine/step-definition.js';
import type { UpgradePlanOutput } from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import {
  upgradeApplyStep,
  type RtkBlockStrip,
} from '../src/step-engine/steps/onboarding-upgrade/02-upgrade-apply.js';
import { upgradeRollbackStep } from '../src/step-engine/steps/onboarding-upgrade/04-upgrade-rollback.js';
import { buildRtkAwarenessBlock } from '../src/step-engine/steps/onboarding/_rtk-templates.js';
import { REFERENCE_CONTEXT } from '../src/step-engine/template-manifest.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000c1';
const ROLLBACK = '00000000-0000-4000-8000-0000000000c2';

const LEGACY_REF = `${RTK_REF_MARKER_START}\n@RTK.md\n${RTK_REF_MARKER_END}\n`;
const AGENTS_LEFT = '# Project\n\nOur notes.\n';
const AGENTS = `${AGENTS_LEFT}${buildRtkAwarenessBlock()}`;
const CLAUDE_LEFT = '@AGENTS.md\nMore notes.\n';
const CLAUDE = `@AGENTS.md\n${LEGACY_REF}More notes.\n`;
const hashOf = (text: string) => sha256Hex(normalizeContent(text));

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A repository whose AGENTS.md and CLAUDE.md hold an RTK block, and an upgrade planned with RTK
 *  off that changes nothing else. */
async function setup(agents: string | Buffer = AGENTS) {
  const root = await mkdtemp(join(tmpdir(), 'upgrade-rtk-block-rollback-'));
  dirs.push(root);
  await writeFile(join(root, 'AGENTS.md'), agents);
  await writeFile(join(root, 'CLAUDE.md'), CLAUDE, 'utf8');
  const fake = createFakeDb({
    onboardingArtifacts: schema.onboardingArtifacts,
    repositories: schema.repositories,
    customBundles: schema.customBundles,
    customBundleItems: schema.customBundleItems,
    cliProviders: schema.cliProviders,
  });
  const noop = () => undefined;
  const ctxFor = (taskId: string) =>
    ({
      db: fake.db,
      repoPath: root,
      taskId,
      userId: USER,
      logger: { info: noop, warn: noop, error: noop, debug: noop },
    }) as unknown as StepContext;
  const plan = {
    repositoryId: REPO,
    ranBackfill: false,
    entries: [],
    counts: {
      unchanged: 0,
      clean_update: 0,
      adopt: 0,
      conflict: 0,
      new_artifact: 0,
      user_deleted: 0,
      obsolete: 0,
    },
    installedTemplateSetHash: null,
    currentTemplateSetHash: 'set',
    renderCtxSnapshot: { ...REFERENCE_CONTEXT, rtkEnabled: false } as unknown as Record<
      string,
      unknown
    >,
    rtkFollowsLive: true,
    backfilledRows: 0,
  } as UpgradePlanOutput;
  const apply = () =>
    upgradeApplyStep.apply(ctxFor(TASK), {
      detected: plan,
      formValues: {},
      iteration: 0,
      previousIterations: [],
    });
  const rollBack = (rtkBlockStrips: RtkBlockStrip[] | undefined) =>
    upgradeRollbackStep.apply(ctxFor(ROLLBACK), {
      detected: {
        repositoryId: REPO,
        rolledBackFromTaskId: TASK,
        targets: [],
        newArtifactsToUndo: [],
        unrecordedRewrites: [],
        warnings: [],
        rtkBlockStrips,
      },
      formValues: {},
      iteration: 0,
      previousIterations: [],
    } as never);
  const read = (rel: string) => readFile(join(root, rel), 'utf8');
  const records = () =>
    fake.rows(schema.onboardingArtifacts).filter((r) => r.templateKind === 'rtk-block');
  return { root, apply, rollBack, read, records };
}

describe('an upgrade that takes RTK blocks out', () => {
  it('records what each file held, outside the rows a rollback restores', async () => {
    const { apply, read, records } = await setup();
    const out = await apply();
    expect(await read('AGENTS.md')).toBe(AGENTS_LEFT);
    expect(await read('CLAUDE.md')).toBe(CLAUDE_LEFT);
    expect(out.rtkBlockStrips?.map((s) => s.file)).toEqual(['AGENTS.md', 'CLAUDE.md']);
    expect(out.writtenPaths).toEqual(expect.arrayContaining(['AGENTS.md', 'CLAUDE.md']));
    const held = { 'AGENTS.md': [AGENTS, AGENTS_LEFT], 'CLAUDE.md': [CLAUDE, CLAUDE_LEFT] };
    for (const strip of out.rtkBlockStrips ?? []) {
      const [before, left] = held[strip.file as keyof typeof held];
      expect(records().find((r) => r.id === strip.recordId)).toMatchObject({
        diskPath: strip.file,
        taskId: TASK,
        source: 'backfill',
        writtenContent: before,
        lastObservedDiskHash: hashOf(left!),
        supersededAt: expect.any(Date),
      });
      expect(out.retiredRowIds).not.toContain(strip.recordId);
    }
  });

  it('takes the records an earlier attempt made when a retry finds the blocks gone', async () => {
    const { apply, records } = await setup();
    const first = await apply();
    const retried = await apply();
    expect(retried.rtkBlockStrips).toEqual(first.rtkBlockStrips);
    expect(retried.writtenPaths).toEqual(expect.arrayContaining(['AGENTS.md', 'CLAUDE.md']));
    expect(records()).toHaveLength(2);
  });

  // What a save landing while the strip was parked leaves there, as does an edit between attempts.
  it('takes no earlier record for a file that no longer holds what that strip left', async () => {
    const { root, apply } = await setup();
    await apply();
    await writeFile(join(root, 'AGENTS.md'), '# Mine\n');
    const retried = await apply();
    expect(retried.rtkBlockStrips?.map((s) => s.file)).toEqual(['CLAUDE.md']);
    expect(retried.writtenPaths).not.toContain('AGENTS.md');
  });

  it('leaves a file that is not UTF-8 as it is, and records nothing for it', async () => {
    const bytes = Buffer.concat([
      Buffer.from('# Caf'),
      Buffer.from([0xe9]),
      Buffer.from(`\n${buildRtkAwarenessBlock()}`),
    ]);
    const { root, apply } = await setup(bytes);
    const out = await apply();
    expect((await readFile(join(root, 'AGENTS.md'))).equals(bytes)).toBe(true);
    expect(out.rtkBlockStrips?.map((s) => s.file)).toEqual(['CLAUDE.md']);
    expect(out.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^could not check AGENTS\.md .*not valid UTF-8/),
      ]),
    );
  });
});

describe('rolling back an upgrade that took RTK blocks out', () => {
  it('puts each block back where it stood, and a retry counts them as put back', async () => {
    const { apply, rollBack, read } = await setup();
    const out = await apply();
    const undone = await rollBack(out.rtkBlockStrips);
    expect(await read('AGENTS.md')).toBe(AGENTS);
    expect(await read('CLAUDE.md')).toBe(CLAUDE);
    expect(undone.revertedCount).toBe(2);
    expect(undone.warnings).toEqual([]);
    const retried = await rollBack(out.rtkBlockStrips);
    expect(retried.revertedCount).toBe(2);
    expect(await read('CLAUDE.md')).toBe(CLAUDE);
  });

  it('keeps what changed since, and says why', async () => {
    const { root, apply, rollBack, read } = await setup();
    const out = await apply();
    const other = `${AGENTS_LEFT}${LEGACY_REF}`;
    await writeFile(join(root, 'AGENTS.md'), other);
    await rm(join(root, 'CLAUDE.md'));
    const undone = await rollBack(out.rtkBlockStrips);
    expect(await read('AGENTS.md')).toBe(other);
    await expect(read('CLAUDE.md')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(undone.revertedCount).toBe(0);
    expect(undone.warnings).toEqual([
      'did not put back the RTK block in AGENTS.md: it holds another RTK block now',
      'did not put back the RTK block in CLAUDE.md: it was removed after the upgrade',
    ]);
  });

  it('names a strip whose record is gone rather than guess what the file held', async () => {
    const { apply, rollBack, read } = await setup();
    await apply();
    const undone = await rollBack([{ file: 'AGENTS.md', recordId: randomUUID() }]);
    expect(await read('AGENTS.md')).toBe(AGENTS_LEFT);
    expect(undone.warnings).toEqual([
      'cannot put back the RTK block in AGENTS.md: no record of what it held',
    ]);
  });
});
