import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb, type FakeDbHandle } from '@haive/database/testing';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { StepContext } from '../src/step-engine/step-definition.js';
import type { UpgradePlanOutput } from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import { upgradeApplyStep } from '../src/step-engine/steps/onboarding-upgrade/02-upgrade-apply.js';
import { renderContextColumnFor } from '../src/project-state/write.js';
import { REFERENCE_CONTEXT } from '../src/step-engine/template-manifest.js';
import { RECORD_WRITE_TABLES, recordWritten } from './support/upgrade-apply-record.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000c1';
const BUNDLE = '00000000-0000-4000-8000-0000000000e1';
const ITEM = '00000000-0000-4000-8000-0000000000e2';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const AGENT = {
  id: 'billing',
  title: 'Billing',
  description: 'Billing agent',
  color: 'blue',
  field: 'billing',
  tools: [],
  coreMission: 'Bill',
  responsibilities: [],
  whenInvoked: [],
  executionSteps: [],
  outputFormat: '',
  qualityCriteria: [],
  antiPatterns: [],
};

/** Applies an empty plan for a repository whose rules override is `override`, and returns the
 *  applicable set 02 wrote. The owner's provider holds rules of its own, which the set ignores. */
async function run(withColumn: boolean, override: string | null = '- repository rule') {
  const root = await mkdtemp(join(tmpdir(), 'upgrade-apply-set-'));
  dirs.push(root);
  const fake = createFakeDb({
    onboardingArtifacts: schema.onboardingArtifacts,
    repositories: schema.repositories,
    customBundles: schema.customBundles,
    customBundleItems: schema.customBundleItems,
    cliProviders: schema.cliProviders,
    ...RECORD_WRITE_TABLES,
  });
  const column = renderContextColumnFor(REFERENCE_CONTEXT, false);
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'acme',
    source: 'blank',
    renderContext: withColumn ? column : null,
    applicableTemplateIds: null,
    agentRulesOverride: override,
  });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    repositoryId: REPO,
    type: 'onboarding_upgrade',
    status: 'running',
    title: 'upgrade',
  });
  fake.insert(schema.cliProviders, {
    userId: USER,
    name: 'claude-code',
    label: 'Claude Code',
    enabled: true,
    rulesContent: 'Always be kind.',
  });
  fake.insert(schema.customBundles, {
    id: BUNDLE,
    userId: USER,
    repositoryId: REPO,
    name: 'acme-kit',
    sourceType: 'zip',
    storageRoot: '/bundles/acme-kit',
  });
  fake.insert(schema.customBundleItems, {
    id: ITEM,
    bundleId: BUNDLE,
    kind: 'agent',
    sourceFormat: 'claude-md',
    sourcePath: 'agents/billing.md',
    normalizedSpec: AGENT,
    contentHash: 'c'.repeat(64),
  });
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
      foreign: 0,
    },
    installedTemplateSetHash: null,
    currentTemplateSetHash: 'set',
    renderCtxSnapshot: REFERENCE_CONTEXT as unknown as Record<string, unknown>,
    ...(withColumn ? { renderContextColumn: column } : {}),
    agentRulesOverride: override,
    backfilledRows: 0,
  } as UpgradePlanOutput;
  const noop = () => undefined;
  // Model only the new transaction-local setting statements. The shared fake continues to own
  // locks/writes; the PostgreSQL suite separately proves actual timeout and restoration behavior.
  const withLockSetting = (handle: FakeDbHandle): FakeDbHandle => {
    let wait = '0';
    return new Proxy(handle, {
      get(target, prop) {
        if (prop === 'transaction')
          return (fn: (tx: FakeDbHandle) => Promise<unknown>) =>
            target.transaction((tx) => fn(withLockSetting(tx)));
        if (prop === 'execute')
          return async (query: unknown) => {
            const parsed = new PgDialect().sqlToQuery(query as SQL);
            if (parsed.sql === "select current_setting('lock_timeout') as value")
              return [{ value: wait }];
            if (
              parsed.sql === "select set_config('lock_timeout', $1, true)" &&
              typeof parsed.params[0] === 'string'
            ) {
              wait = parsed.params[0];
              return [{ set_config: wait }];
            }
            return target.execute(query);
          };
        return Reflect.get(target, prop);
      },
    });
  };
  const ctx = {
    db: withLockSetting(fake.db as unknown as FakeDbHandle),
    repoPath: root,
    taskId: TASK,
    userId: USER,
    throwIfCancelled: () => {},
    logger: { info: noop, warn: noop, error: noop, debug: noop },
  } as unknown as StepContext;
  await recordWritten(
    upgradeApplyStep.apply(ctx, {
      detected: plan,
      formValues: {},
      iteration: 0,
      previousIterations: [],
    }),
  );
  return fake.rows(schema.repositories)[0]!.applicableTemplateIds as string[];
}

describe('02 writes the applicable set the way 01 and the sync do', () => {
  it.each([
    ['a plan that read no column', false],
    ['a plan that read the column, inside its fenced transaction', true],
  ])('holds the custom bundle item and cli-rules after %s', async (_name, withColumn) => {
    const set = await run(withColumn);

    expect(set).toContain(`custom.${BUNDLE}.${ITEM}`);
    expect(set).toContain('cli-rules');
    expect(set).toContain('workflow-config');
  });

  it('holds cli-rules for a repository with no override, which follows the default rules', async () => {
    expect(await run(true, null)).toContain('cli-rules');
  });

  it('leaves cli-rules out for an empty override, whatever rules its owner provider holds', async () => {
    const set = await run(true, '');

    expect(set).not.toContain('cli-rules');
    expect(set).toContain(`custom.${BUNDLE}.${ITEM}`);
    expect(set).toContain('workflow-config');
  });
});
