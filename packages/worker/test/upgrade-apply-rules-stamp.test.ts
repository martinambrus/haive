import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  CLI_RULES_END,
  CLI_RULES_START,
  CLI_RULES_TEMPLATE_KIND,
  normalizeContent,
  sha256Hex,
} from '@haive/shared';
import type { StepContext } from '../src/step-engine/step-definition.js';
import type {
  UpgradePlanEntry,
  UpgradePlanOutput,
} from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import { upgradeApplyStep } from '../src/step-engine/steps/onboarding-upgrade/02-upgrade-apply.js';
import { REFERENCE_CONTEXT } from '../src/step-engine/template-manifest.js';
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
  const fake = createFakeDb({
    onboardingArtifacts: schema.onboardingArtifacts,
    repositories: schema.repositories,
    customBundles: schema.customBundles,
    customBundleItems: schema.customBundleItems,
    cliProviders: schema.cliProviders,
    ...RECORD_WRITE_TABLES,
  });
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'acme',
    source: 'blank',
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
  return { fake, apply, agentsMd };
}

describe('02 and the rules override its plan was made from', () => {
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
