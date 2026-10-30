import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import {
  buildCliRulesBlock,
  buildRepoCliRulesBlock,
  CLI_RULES_DISK_PATH,
  CLI_RULES_SCHEMA_VERSION,
  CLI_RULES_TEMPLATE_ID,
  CLI_RULES_TEMPLATE_KIND,
  DEFAULT_AGENT_RULES,
  normalizeContent,
  sha256Hex,
} from '@haive/shared';
import { resolveRenderContext, unionExpandedFor } from '../src/step-engine/_upgrade-render.js';
import { upgradePlanStep } from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import { renderContextColumnFor } from '../src/project-state/write.js';
import { REFERENCE_CONTEXT } from '../src/step-engine/template-manifest.js';
import {
  REPO,
  USER,
  ctxFor,
  newDb,
  seedProviders,
  seedRepository,
} from './support/upgrade-plan-fixtures.js';

// The AGENTS.md rules region is the REPOSITORY's: every writer and reader renders it from
// `repositories.agent_rules_override` (NULL follows Haive's default, '' renders none), and the rules
// of the person asking never enter.

const OTHER_USER = '00000000-0000-4000-8000-0000000000a2';
const OTHER_REPO = '00000000-0000-4000-8000-0000000000b2';
const COLUMN = renderContextColumnFor(REFERENCE_CONTEXT, false);
const noop = () => undefined;
const logger = { info: noop, warn: noop, error: noop, debug: noop };
const hashOf = (text: string) => sha256Hex(normalizeContent(text));
const DEFAULT_BLOCK = buildCliRulesBlock([DEFAULT_AGENT_RULES]) as string;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'upgrade-render-rules-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function world(override: string | null | undefined) {
  const fake = newDb();
  seedProviders(fake);
  seedRepository(fake, {
    source: 'git_https',
    rtkEnabled: false,
    renderContext: COLUMN,
    ...(override === undefined ? {} : { agentRulesOverride: override }),
  });
  return fake;
}

const rendering = async (fake: ReturnType<typeof world>, userId = USER, repositoryId = REPO) =>
  (
    await unionExpandedFor(fake.db as never, {
      repositoryId,
      userId,
      renderCtx: REFERENCE_CONTEXT,
      logger,
    })
  ).find((r) => r.templateId === CLI_RULES_TEMPLATE_ID);

describe('unionExpandedFor and the cli-rules region', () => {
  it('renders the default rules while the repository holds no override', async () => {
    const r = await rendering(world(null));

    expect(r).toMatchObject({
      templateKind: CLI_RULES_TEMPLATE_KIND,
      templateSchemaVersion: CLI_RULES_SCHEMA_VERSION,
      diskPath: CLI_RULES_DISK_PATH,
      content: DEFAULT_BLOCK,
      templateContentHash: hashOf(DEFAULT_BLOCK),
      writtenHash: hashOf(DEFAULT_BLOCK),
    });
  });

  it('renders the override as written', async () => {
    const r = await rendering(world('- only this rule'));

    const block = buildRepoCliRulesBlock('- only this rule') as string;
    expect(r?.content).toBe(block);
    expect(r?.templateContentHash).toBe(hashOf(block));
    expect(r?.templateContentHash).not.toBe(hashOf(DEFAULT_BLOCK));
  });

  it.each([
    ['empty', ''],
    ['blank', '  \n\t'],
  ])('renders no region for an %s override', async (_name, override) => {
    expect(await rendering(world(override))).toBeUndefined();
  });

  it('renders the same region for two repositories of different owners with the same override', async () => {
    const fake = world('- shared rule');
    // The other owner has other providers, one of them with rules of its own.
    fake.insert(schema.cliProviders, {
      userId: OTHER_USER,
      name: 'codex',
      label: 'codex',
      enabled: true,
      rulesContent: '- the other owner personal rule',
    });
    fake.insert(schema.repositories, {
      id: OTHER_REPO,
      userId: OTHER_USER,
      name: 'beta',
      source: 'git_https',
      status: 'ready',
      rtkEnabled: false,
      renderContext: COLUMN,
      agentRulesOverride: '- shared rule',
    });

    const mine = await rendering(fake);
    const theirs = await rendering(fake, OTHER_USER, OTHER_REPO);

    expect(mine).toBeDefined();
    expect(theirs).toEqual(mine);
  });

  it('is not moved by the personal rules of the person asking', async () => {
    const plain = await rendering(world(null));
    const fake = world(null);
    const claude = fake
      .rows(schema.cliProviders)
      .find((r) => r.userId === USER && r.name === 'claude-code');
    fake.patch(schema.cliProviders, claude!.id as string, { rulesContent: '- my personal rule' });

    expect(await rendering(fake)).toEqual(plain);
  });
});

describe('resolveRenderContext and the plan stamp', () => {
  const resolved = async (override: string | null) =>
    resolveRenderContext(world(override).db as never, {
      repositoryId: REPO,
      userId: USER,
      liveRows: [],
      logger,
    });

  it.each([
    ['text', '- a rule'],
    ['the empty string', ''],
    ['NULL', null],
  ])('returns the override as it read %s, NULL and empty apart', async (_name, stored) => {
    expect((await resolved(stored))?.agentRulesOverride).toBe(stored);
  });

  it.each([
    ['text', '- a rule'],
    ['the empty string', ''],
    ['NULL', null],
  ])('01 stamps its plan with the override it read: %s', async (_name, stored) => {
    const fake = world(stored);
    const detected = await upgradePlanStep.detect!(ctxFor(fake, dir));

    expect(detected.agentRulesOverride).toBe(stored);
  });
});

describe('01 and the AGENTS.md region of a repository two people share', () => {
  /** AGENTS.md holds the default region, which a live row records, as a first onboarding left it. */
  async function planFor(userId: string, mine: string | null) {
    const fake = world(null);
    fake.insert(schema.cliProviders, {
      userId: OTHER_USER,
      name: 'claude-code',
      label: 'claude-code',
      enabled: true,
      rulesContent: '- a personal rule',
    });
    await writeFile(join(dir, 'AGENTS.md'), `# Project\n\n${DEFAULT_BLOCK}\n`);
    fake.insert(schema.onboardingArtifacts, {
      userId: USER,
      repositoryId: REPO,
      taskId: null,
      diskPath: CLI_RULES_DISK_PATH,
      templateId: CLI_RULES_TEMPLATE_ID,
      templateKind: CLI_RULES_TEMPLATE_KIND,
      templateSchemaVersion: CLI_RULES_SCHEMA_VERSION,
      templateContentHash: hashOf(DEFAULT_BLOCK),
      writtenHash: hashOf(DEFAULT_BLOCK),
      writtenContent: DEFAULT_BLOCK.trimEnd(),
      userModified: false,
      formValuesSnapshot: REFERENCE_CONTEXT,
      sourceStepId: '12-post-onboarding',
      source: 'onboarding',
      haiveVersion: null,
      generatedAt: new Date(1000),
      supersededAt: null,
      bundleItemId: null,
    });
    if (mine !== null) fake.patch(schema.repositories, REPO, { agentRulesOverride: mine });
    const detected = await upgradePlanStep.detect!({ ...ctxFor(fake, dir), userId });
    return detected.entries.find((e) => e.diskPath === CLI_RULES_DISK_PATH);
  }

  it('plans the region unchanged for the owner and for another person with rules of their own', async () => {
    const owner = await planFor(USER, null);
    const other = await planFor(OTHER_USER, null);

    expect(owner?.bucket).toBe('unchanged');
    expect(other?.bucket).toBe('unchanged');
  });

  it('plans a clean update for both once the repository override differs from the region', async () => {
    const owner = await planFor(USER, '- the new repository rule');
    const other = await planFor(OTHER_USER, '- the new repository rule');

    expect(owner?.bucket).toBe('clean_update');
    expect(other?.bucket).toBe('clean_update');
    expect(owner?.newContentHash).toBe(other?.newContentHash);
  });

  it('plans the region obsolete for both once the repository override is empty', async () => {
    const owner = await planFor(USER, '');
    const other = await planFor(OTHER_USER, '');

    expect(owner?.bucket).toBe('obsolete');
    expect(other?.bucket).toBe('obsolete');
  });
});
