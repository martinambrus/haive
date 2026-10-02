import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableName, is, SQL, StringChunk } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb, type FakeDbHandle } from '@haive/database/testing';
import {
  emptyProjectState,
  normalizeProjectState,
  renderContextColumnSchema,
  renderProjectState,
  type ProjectRender,
  type ProjectStateRecord,
} from '@haive/shared/project-state';
import { syncProjectStateFromCheckout } from '../src/project-state/sync.js';
import type { StepContext } from '../src/step-engine/step-definition.js';
import {
  expandManifestFor,
  type TemplateRenderContext,
} from '../src/step-engine/template-manifest.js';
import {
  upgradePlanStep,
  type UpgradePlanDetect,
} from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import { upgradeApplyStep } from '../src/step-engine/steps/onboarding-upgrade/02-upgrade-apply.js';

// A sync that changes the render context of a repository holding a claim writes, in the same
// transaction, exactly the applicable template ids its context renders (design-d.md as amended by
// design-227.md). Every set below is a sorted literal derived from the fixture by hand: the owner has
// claude-code and codex on and gemini off, another user has gemini on, and the repository comes from
// git_https.

const OWNER = '00000000-0000-4000-8000-0000000000a1';
const STRANGER = '00000000-0000-4000-8000-0000000000a2';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const ONBOARDING = '00000000-0000-4000-8000-0000000000c1';
const UPGRADE = '00000000-0000-4000-8000-0000000000c2';

const STATE_DIR = '.haive-data/state';
const LOCK = 'execute select pg_advisory_xact_lock(hashtextextended(';
const HASH = 'a'.repeat(64);

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

type Json = Record<string, unknown>;

const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;
/** A jsonb value as Postgres hands it back: object keys by length, then bytes. */
const jsonb = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(jsonb);
  if (value === null || typeof value !== 'object') return value;
  const byKey = ([a]: [string, unknown], [b]: [string, unknown]) =>
    a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(byKey)
      .map(([key, member]) => [key, jsonb(member)]),
  );
};

// ---- the fixture -------------------------------------------------------------------------------

const render = (over: Partial<ProjectRender> = {}): ProjectRender => ({
  projectInfo: { name: 'acme', framework: 'drupal' },
  framework: 'drupal',
  acceptedAgentIds: ['code-reviewer', 'security-auditor'],
  customAgentSpecs: [],
  lspLanguages: ['php-extended'],
  ...over,
});
const BASE = render();
const TEAM = render({ acceptedAgentIds: ['code-reviewer', 'security-auditor', 'test-writer'] });
/** BASE without security-auditor: its claims are no longer rendered. */
const TEAM2 = render({ acceptedAgentIds: ['code-reviewer'] });
const LATER = render({ framework: 'drupal11' });

/** What the owner's install derives from claude-code and codex, as step 12 records it. */
const OWNER_INSTALL = {
  agentTargets: [
    { dir: '.claude/agents', format: 'markdown', supportsLsp: true },
    { dir: '.codex/agents', format: 'toml', supportsLsp: false },
  ],
  enabledCliProviders: [
    { name: 'claude-code', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' },
    { name: 'codex', rulesFile: 'AGENTS.md', rulesFileMode: 'native' },
  ],
  rtkEnabled: false,
};
/** A render context column as 12 writes it: the render unit, the per-install fields, the RTK flag. */
const column = (r: ProjectRender, over: Json = {}): Json => ({
  ...r,
  ...OWNER_INSTALL,
  rtkChoiceRecorded: true,
  ...over,
});

const record = (r: ProjectRender | null): ProjectStateRecord => ({
  ...emptyProjectState(),
  render: r,
});
const baseOf = (r: ProjectRender): unknown => json(normalizeProjectState(record(r)));

const PLUGIN_JSON =
  'plugin.drupal-php-lsp..claude/plugins/drupal-php-lsp/.claude-plugin/drupal-php-lsp/.claude-plugin/plugin.json';
const PLUGIN_LSP =
  'plugin.drupal-php-lsp..claude/plugins/drupal-php-lsp/.claude-plugin/drupal-php-lsp/.lsp.json';
const PLUGIN_MARKETPLACE =
  'plugin.drupal-php-lsp..claude/plugins/drupal-php-lsp/.claude-plugin/marketplace.json';

/** What 01 computes for BASE and the owner, RTK off. It holds cli-rules, which 12 records only when
 *  AGENTS.md carries the region. */
const P = [
  'agent.code-reviewer',
  'agent.security-auditor',
  'agents-index',
  'cli-rules',
  PLUGIN_JSON,
  PLUGIN_LSP,
  PLUGIN_MARKETPLACE,
  'workflow-config',
];
/** The same for TEAM, which adds the baseline agent test-writer. */
const D1_SET = [
  'agent.code-reviewer',
  'agent.security-auditor',
  'agent.test-writer',
  'agents-index',
  'cli-rules',
  PLUGIN_JSON,
  PLUGIN_LSP,
  PLUGIN_MARKETPLACE,
  'workflow-config',
];
/** TEAM with RTK settings for claude-code, which reads them; gemini is off for the owner. */
const TEAM_WITH_RTK = [
  'agent.code-reviewer',
  'agent.security-auditor',
  'agent.test-writer',
  'agents-index',
  'cli-rules',
  PLUGIN_JSON,
  PLUGIN_LSP,
  PLUGIN_MARKETPLACE,
  'rtk.claude-settings',
  'workflow-config',
];
const P_WITH_RTK = [
  'agent.code-reviewer',
  'agent.security-auditor',
  'agents-index',
  'cli-rules',
  PLUGIN_JSON,
  PLUGIN_LSP,
  PLUGIN_MARKETPLACE,
  'rtk.claude-settings',
  'workflow-config',
];
const P_WITH_DOCS = [
  'agent.code-reviewer',
  'agent.docs-writer',
  'agent.security-auditor',
  'agents-index',
  'cli-rules',
  PLUGIN_JSON,
  PLUGIN_LSP,
  PLUGIN_MARKETPLACE,
  'workflow-config',
];
/** What 01 computes for TEAM2: P without the agent the claims still record. */
const TEAM2_SET = [
  'agent.code-reviewer',
  'agents-index',
  'cli-rules',
  PLUGIN_JSON,
  PLUGIN_LSP,
  PLUGIN_MARKETPLACE,
  'workflow-config',
];

interface Claim {
  path: string;
  id: string;
  kind: string;
}
const claim = (path: string, id: string, kind: string): Claim => ({ path, id, kind });
/** Every rendering of BASE, recorded as 12 records them. */
const BASE_CLAIMS: Claim[] = [
  claim('.claude/workflow-config.json', 'workflow-config', 'workflow-config'),
  claim('.claude/agents/README.md', 'agents-index', 'agents-index'),
  claim('.codex/agents/README.md', 'agents-index', 'agents-index'),
  claim('.claude/agents/code-reviewer.md', 'agent.code-reviewer', 'agent'),
  claim('.codex/agents/code-reviewer.toml', 'agent.code-reviewer', 'agent'),
  claim('.claude/agents/security-auditor.md', 'agent.security-auditor', 'agent'),
  claim('.codex/agents/security-auditor.toml', 'agent.security-auditor', 'agent'),
  claim(
    '.claude/plugins/drupal-php-lsp/.claude-plugin/marketplace.json',
    PLUGIN_MARKETPLACE,
    'plugin-file',
  ),
  claim(
    '.claude/plugins/drupal-php-lsp/.claude-plugin/drupal-php-lsp/.claude-plugin/plugin.json',
    PLUGIN_JSON,
    'plugin-file',
  ),
  claim(
    '.claude/plugins/drupal-php-lsp/.claude-plugin/drupal-php-lsp/.lsp.json',
    PLUGIN_LSP,
    'plugin-file',
  ),
  claim('AGENTS.md', 'cli-rules', 'cli-rules-block'),
];
const RTK_CLAIM = claim('.claude/settings.json', 'rtk.claude-settings', 'rtk-config');
const DOCS_CLAIM = claim('.claude/agents/docs-writer.md', 'agent.docs-writer', 'agent');

// ---- the repository, its database and the statements it is sent --------------------------------

interface Seed {
  /** `repositories.render_context`. */
  column?: unknown;
  /** `repositories.applicable_template_ids`, NULL unless given. */
  set?: string[] | null;
  claims?: readonly Claim[];
  /** Rows a later write superseded: no longer claims. */
  retired?: readonly Claim[];
  /** The record the sync row holds as its base; no sync row without one. */
  base?: ProjectRender;
  lastError?: string;
  /** The repository's live RTK switch. */
  rtk?: boolean;
}

const isWrite = (event: string) => /^(update|insert|delete) /.test(event);
const writesTo = (trace: string[], table: string) =>
  trace.filter((e) => isWrite(e) && e.endsWith(` ${table}`));

function transactions(trace: string[]): { outside: string[]; inside: string[][] } {
  const outside: string[] = [];
  const inside: string[][] = [];
  let current: string[] | null = null;
  for (const event of trace) {
    if (event === 'begin') current = [];
    else if (event === 'end') {
      if (current) inside.push(current);
      current = null;
    } else (current ?? outside).push(event);
  }
  return { outside, inside };
}

/** Whatever a sync wrote, it wrote inside one transaction whose first statement is the lock. */
function expectWritesUnderTheLock(trace: string[]): void {
  const { outside, inside } = transactions(trace);
  expect(outside.filter(isWrite)).toEqual([]);
  expect(inside).toHaveLength(1);
  expect(inside[0]![0]).toBe(LOCK);
}

async function setup(seed: Seed = {}) {
  const root = await mkdtemp(join(tmpdir(), 'project-state-sync-applicable-'));
  dirs.push(root);
  const { repositories, projectStateSync: sync, tasks, onboardingArtifacts, cliProviders } = schema;
  const fake = createFakeDb({
    tasks,
    taskSteps: schema.taskSteps,
    repositories,
    projectStateSync: sync,
    onboardingArtifacts,
    cliProviders,
    customBundles: schema.customBundles,
    customBundleItems: schema.customBundleItems,
  });
  fake.insert(repositories, {
    id: REPO,
    userId: OWNER,
    name: 'acme',
    source: 'git_https',
    status: 'ready',
    rtkEnabled: seed.rtk ?? false,
    renderContext: jsonb(seed.column ?? null),
    applicableTemplateIds: seed.set ?? null,
    updatedAt: new Date(1000),
  });
  for (const [userId, name, enabled] of [
    [OWNER, 'claude-code', true],
    [OWNER, 'codex', true],
    [OWNER, 'gemini', false],
    [STRANGER, 'gemini', true],
  ] as const) {
    fake.insert(cliProviders, { userId, name, label: name, enabled, rulesContent: '' });
  }
  fake.insert(tasks, {
    id: ONBOARDING,
    userId: OWNER,
    repositoryId: REPO,
    type: 'onboarding',
    status: 'completed',
    title: 'onboarding',
    completedAt: new Date(5000),
  });
  const snapshot = { ...BASE, ...OWNER_INSTALL };
  const insertClaim = (c: Claim, over: Json = {}) =>
    fake.insert(onboardingArtifacts, {
      userId: OWNER,
      repositoryId: REPO,
      taskId: ONBOARDING,
      diskPath: c.path,
      templateId: c.id,
      templateKind: c.kind,
      templateSchemaVersion: 1,
      templateContentHash: HASH,
      writtenHash: HASH,
      userModified: false,
      formValuesSnapshot: snapshot,
      sourceStepId: '12-post-onboarding',
      source: 'onboarding',
      haiveVersion: null,
      generatedAt: new Date(5000),
      supersededAt: null,
      bundleItemId: null,
      ...over,
    });
  for (const c of seed.claims ?? []) insertClaim(c);
  for (const c of seed.retired ?? []) insertClaim(c, { supersededAt: new Date(6000) });
  if (seed.base) {
    fake.insert(sync, {
      repositoryId: REPO,
      baseSnapshot: jsonb(baseOf(seed.base)),
      lastError: seed.lastError ?? null,
      updatedAt: new Date(0),
    });
  }

  const events: string[] = [];
  const hook = {
    /** A select from this table throws. */
    failSelect: null as PgTable | null,
    /** The nth update of the repositories table throws, counted through the hook's table argument. */
    failRepositoryUpdate: 0,
    onLock: null as (() => void) | null,
  };
  let repositoryUpdates = 0;
  fake.hooks.beforeLock = () => hook.onLock?.();
  const written = (verb: string) => (table: PgTable) => {
    events.push(`${verb} ${getTableName(table)}`);
    if (verb === 'update' && table === repositories) {
      repositoryUpdates += 1;
      if (repositoryUpdates === hook.failRepositoryUpdate) throw new Error('database refused');
    }
  };
  fake.hooks.beforeUpdate = written('update');
  fake.hooks.beforeInsert = written('insert');
  fake.hooks.beforeDelete = written('delete');

  const describeSql = (query: unknown): string => {
    const first = is(query, SQL) ? query.queryChunks[0] : undefined;
    return first instanceof StringChunk ? first.value.join('') : '(not sql text)';
  };
  const traced = (handle: FakeDbHandle): FakeDbHandle =>
    new Proxy(handle, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (prop === 'transaction') {
          return (fn: (tx: FakeDbHandle) => Promise<unknown>) => {
            events.push('begin');
            return (value as FakeDbHandle['transaction'])((tx) => fn(traced(tx))).finally(() =>
              events.push('end'),
            );
          };
        }
        if (prop === 'select') {
          return (...args: Parameters<FakeDbHandle['select']>) => {
            const builder = (value as FakeDbHandle['select'])(...args);
            return {
              from: (table: PgTable) => {
                events.push(`select ${getTableName(table)}`);
                if (table === hook.failSelect) throw new Error('database refused');
                return builder.from(table);
              },
            };
          };
        }
        if (prop === 'execute') {
          return (query: unknown) => {
            events.push(`execute ${describeSql(query)}`);
            return (value as FakeDbHandle['execute'])(query);
          };
        }
        return value;
      },
    });
  const db = traced(fake.db as unknown as FakeDbHandle) as unknown as Database;

  const put = async (rel: string, data: string) => {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), data);
  };
  const putRecord = async (r: ProjectRender) => {
    for (const [rel, text] of renderProjectState(record(r))) await put(`${STATE_DIR}/${rel}`, text);
  };
  const run = async () => {
    const start = events.length;
    const result = await syncProjectStateFromCheckout(db, { repositoryId: REPO, repoPath: root });
    return { outcome: result.outcome as string, trace: events.slice(start) };
  };

  const upgradeCtx = (): StepContext => {
    const noop = () => undefined;
    return {
      round: 0,
      taskId: UPGRADE,
      taskStepId: '00000000-0000-4000-8000-0000000000e1',
      userId: OWNER,
      repoPath: root,
      workspacePath: root,
      sandboxWorkdir: '/haive/workdir',
      cliProviderId: null,
      db: fake.db,
      logger: { info: noop, warn: noop, error: noop, debug: noop },
      signal: new AbortController().signal,
      throwIfCancelled: noop,
      async emitProgress() {},
    } as unknown as StepContext;
  };

  /** 02's apply of a plan 01 detected, with the form left at its defaults. */
  const applyPlan = async (detected: UpgradePlanDetect) => {
    await upgradeApplyStep.apply(upgradeCtx(), {
      detected: { ...detected, backfilledRows: 0 },
      formValues: {},
      iteration: 0,
      previousIterations: [],
    });
  };

  /** 01's detect and apply for the upgrade task of this repository, run as its owner. */
  const plan = async (): Promise<UpgradePlanDetect> => {
    fake.insert(tasks, {
      id: UPGRADE,
      userId: OWNER,
      repositoryId: REPO,
      type: 'onboarding_upgrade',
      status: 'running',
      title: 'upgrade',
    });
    const ctx = upgradeCtx();
    const detected = await upgradePlanStep.detect!(ctx);
    await upgradePlanStep.apply(ctx, {
      detected,
      formValues: {},
      iteration: 0,
      previousIterations: [],
    });
    return detected;
  };

  const rowOf = (): Json => json(fake.rows(repositories).find((r) => r.id === REPO)) as Json;
  const syncRow = () => fake.rows(sync).find((r) => r.repositoryId === REPO);
  return {
    root,
    fake,
    hook,
    events,
    put,
    putRecord,
    run,
    plan,
    applyPlan,
    rowOf,
    syncRow,
    setOf: (): unknown => rowOf().applicableTemplateIds ?? null,
    columnOf: (): unknown => rowOf().renderContext ?? null,
    dump: () => json({ repositories: fake.rows(repositories), projectStateSync: fake.rows(sync) }),
    patchBase: (r: ProjectRender) =>
      fake.patch(sync, syncRow()!.id as string, {
        baseSnapshot: jsonb(baseOf(r)),
        lastError: null,
      }),
    addTask: (type: string, status: string) =>
      fake.insert(tasks, {
        id: '00000000-0000-4000-8000-0000000000c9',
        userId: OWNER,
        repositoryId: REPO,
        type,
        status,
        title: 't',
      }),
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** The repository row without the three columns a recompute writes. */
const withoutRecomputed = (row: Json): Json => {
  const { renderContext: _c, applicableTemplateIds: _a, updatedAt: _u, ...rest } = row;
  return rest;
};

// ---- the controls ------------------------------------------------------------------------------

describe('the fixture', () => {
  it('holds columns the column schema accepts, so no control fails over a refused one', () => {
    const columns = [
      column(BASE),
      column(TEAM),
      column(TEAM2),
      column(render({ framework: 'drupal10' })),
      column(BASE, { rtkEnabled: false, rtkChoiceRecorded: false }),
    ];
    for (const c of columns) expect(renderContextColumnSchema.safeParse(c).success).toBe(true);
  });

  it('holds sets written as the writer leaves them: sorted, and free of duplicates', () => {
    for (const set of [P, D1_SET, TEAM_WITH_RTK, P_WITH_RTK, P_WITH_DOCS, TEAM2_SET]) {
      expect(set).toEqual([...new Set(set)].sort());
    }
  });

  it('claims every rendering of BASE, and nothing the set P lacks', () => {
    expect([...new Set(BASE_CLAIMS.map((c) => c.id))].sort()).toEqual(P);
  });
});

describe('D0: 01 plans and applies as it did before the move', () => {
  it('on a repository with claims, writes the set and backfills nothing', async () => {
    const s = await setup({ column: column(BASE), claims: BASE_CLAIMS, set: null });

    const detected = await s.plan();

    expect(s.setOf()).toEqual(P);
    expect(s.fake.rows(schema.onboardingArtifacts).filter((r) => r.source === 'backfill')).toEqual(
      [],
    );
    // The order the rows are planned in, captured on 53040e53 before the move.
    expect(detected.entries.map((e) => `${e.entryId} ${e.bucket}`)).toEqual([
      'e0:.claude/workflow-config.json user_deleted',
      'e1:.claude/agents/README.md user_deleted',
      'e2:.codex/agents/README.md user_deleted',
      'e3:.claude/agents/code-reviewer.md user_deleted',
      'e4:.codex/agents/code-reviewer.toml user_deleted',
      'e5:.claude/agents/security-auditor.md user_deleted',
      'e6:.codex/agents/security-auditor.toml user_deleted',
      'e7:.claude/plugins/drupal-php-lsp/.claude-plugin/marketplace.json user_deleted',
      'e8:.claude/plugins/drupal-php-lsp/.claude-plugin/drupal-php-lsp/.claude-plugin/plugin.json user_deleted',
      'e9:.claude/plugins/drupal-php-lsp/.claude-plugin/drupal-php-lsp/.lsp.json user_deleted',
      'e10:AGENTS.md user_deleted',
    ]);
  });

  it('on a repository without claims, writes the set and backfills the rows of the files it finds', async () => {
    const s = await setup({ column: column(BASE), set: null });
    // The files whose bodies are constants, as onboarding wrote them: a file no render accounts for
    // is offered as a conflict and never recorded.
    const rendered = expandManifestFor({
      ...BASE,
      ...OWNER_INSTALL,
    } as unknown as TemplateRenderContext);
    const constant = ['workflow-config', PLUGIN_JSON, PLUGIN_LSP, PLUGIN_MARKETPLACE];
    for (const r of rendered.filter((e) => constant.includes(e.templateId))) {
      await s.put(r.diskPath, r.content);
    }

    const detected = await s.plan();

    expect(s.setOf()).toEqual(P);
    // The order the rows are planned in, captured on 53040e53 before the move.
    expect(detected.entries.map((e) => `${e.entryId} ${e.bucket}`)).toEqual([
      'e0:.claude/workflow-config.json new_artifact',
      'e1:.claude/agents/README.md new_artifact',
      'e2:.codex/agents/README.md new_artifact',
      'e3:.claude/agents/code-reviewer.md new_artifact',
      'e4:.codex/agents/code-reviewer.toml new_artifact',
      'e5:.claude/agents/security-auditor.md new_artifact',
      'e6:.codex/agents/security-auditor.toml new_artifact',
      'e7:.claude/plugins/drupal-php-lsp/.claude-plugin/marketplace.json new_artifact',
      'e8:.claude/plugins/drupal-php-lsp/.claude-plugin/drupal-php-lsp/.claude-plugin/plugin.json new_artifact',
      'e9:.claude/plugins/drupal-php-lsp/.claude-plugin/drupal-php-lsp/.lsp.json new_artifact',
      'e10:AGENTS.md new_artifact',
    ]);
    const backfilled = s.fake
      .rows(schema.onboardingArtifacts)
      .filter((r) => r.source === 'backfill')
      .map((r) => [r.diskPath, r.templateId, r.writtenHash, r.source])
      .sort(([a], [b]) => ((a as string) < (b as string) ? -1 : 1));
    // Captured on 53040e53, before the move.
    expect(backfilled).toEqual([
      [
        '.claude/plugins/drupal-php-lsp/.claude-plugin/drupal-php-lsp/.claude-plugin/plugin.json',
        PLUGIN_JSON,
        'da62bbe0b2bb95c32088d10e0bcefa76682d97681b24d174fb6d4d94e0c61261',
        'backfill',
      ],
      [
        '.claude/plugins/drupal-php-lsp/.claude-plugin/drupal-php-lsp/.lsp.json',
        PLUGIN_LSP,
        'a3b028d7bd8d2a38a0a536ab8f9bafe6ac7283779e656c64892087000c23520d',
        'backfill',
      ],
      [
        '.claude/plugins/drupal-php-lsp/.claude-plugin/marketplace.json',
        PLUGIN_MARKETPLACE,
        '8fecf706f85f55cae61e07fc99d380fbf5f9e6b5adb895a531ce470e7e3e4659',
        'backfill',
      ],
      [
        '.claude/workflow-config.json',
        'workflow-config',
        '0de9e5de41c9324456b9a579cf50206326ea2b6bbb0ba1892d7993ca72bce699',
        'backfill',
      ],
    ]);
  });
});

describe('D1: an applied sync on a repository with claims writes the set', () => {
  it('writes the set 01 computes for the column it wrote, and changes nothing else of the row', async () => {
    const s = await setup({ column: column(BASE), base: BASE, set: P, claims: BASE_CLAIMS });
    await s.putRecord(TEAM);
    const before = s.rowOf();

    const { outcome } = await s.run();

    expect(outcome).toBe('applied');
    expect(s.setOf()).toEqual(D1_SET);
    expect(withoutRecomputed(s.rowOf())).toEqual(withoutRecomputed(before));
  });
});

describe('D2: 01 writes the set the sync wrote', () => {
  it('finds it already in place when every claim is still rendered', async () => {
    const s = await setup({ column: column(BASE), base: BASE, set: P, claims: BASE_CLAIMS });
    await s.putRecord(TEAM);
    expect((await s.run()).outcome).toBe('applied');
    const synced = s.setOf();
    for (const c of BASE_CLAIMS) expect(D1_SET).toContain(c.id);

    await s.plan();

    expect(s.setOf()).toEqual(D1_SET);
    expect(synced).toEqual(s.setOf());
  });
});

describe('D2b: a claim the written context stops rendering', () => {
  it('is outside the set the sync wrote, which is the set 01 writes, and 01 plans its files obsolete', async () => {
    const s = await setup({ column: column(BASE), base: BASE, set: P, claims: BASE_CLAIMS });
    await s.putRecord(TEAM2);
    expect((await s.run()).outcome).toBe('applied');
    const synced = s.setOf();

    const detected = await s.plan();

    expect(synced).toEqual(TEAM2_SET);
    expect(s.setOf()).toEqual(TEAM2_SET);
    const bucketOf = (path: string) => detected.entries.find((e) => e.diskPath === path)?.bucket;
    expect(bucketOf('.claude/agents/security-auditor.md')).toBe('obsolete');
    expect(bucketOf('.codex/agents/security-auditor.toml')).toBe('obsolete');
  });
});

describe('D2c: 01 writes what its context renders and retains nothing', () => {
  it('drops an id the set holds and a claim records while the context renders it no more', async () => {
    // The column already accepts TEAM2 and the set still holds agent.security-auditor: no sync ran in between.
    const s = await setup({ column: column(TEAM2), base: TEAM2, set: P, claims: BASE_CLAIMS });
    expect(P).toContain('agent.security-auditor');

    await s.plan();

    expect(s.setOf()).toEqual(TEAM2_SET);
  });
});

describe('D2d: 02 writes what its plan renders and retains nothing', () => {
  it('drops an id the set holds and a claim records while the plan renders it no more', async () => {
    const s = await setup({ column: column(TEAM2), base: TEAM2, set: P, claims: BASE_CLAIMS });
    const detected = await s.plan();
    // The set as 01 found it, holding agent.security-auditor, which 01's write has just dropped.
    s.fake.patch(schema.repositories, REPO, { applicableTemplateIds: P });
    expect(s.setOf()).toEqual(P);

    await s.applyPlan(detected);

    // 02 writes the manifest's ids and the bundles', which is TEAM2_SET without cli-rules: only 01, 12
    // and the sync add that one (design-d.md Found-not-fixed 5).
    expect(s.setOf()).toEqual([
      'agent.code-reviewer',
      'agents-index',
      PLUGIN_JSON,
      PLUGIN_LSP,
      PLUGIN_MARKETPLACE,
      'workflow-config',
    ]);
  });
});

describe('D3: the context the set derives from is the one 01 renders', () => {
  it('completes a column holding no per-install field from the owner CLIs, and follows the live RTK switch', async () => {
    // A first import: claims from before the column, no column and no sync row.
    const s = await setup({ column: null, set: P, claims: BASE_CLAIMS, rtk: true });
    await s.putRecord(TEAM);

    const { outcome } = await s.run();

    expect(outcome).toBe('applied');
    // claude-code is on for the owner and reads rtk.claude-settings; gemini is off for the owner
    // and on for another user, so rtk.gemini-settings is not rendered.
    expect(s.setOf()).toEqual(TEAM_WITH_RTK);
  });

  it('D3b: renders no RTK template when the column recorded no RTK choice, whatever the switch says', async () => {
    const s = await setup({
      column: column(BASE, { rtkEnabled: false, rtkChoiceRecorded: false }),
      base: BASE,
      set: P,
      claims: BASE_CLAIMS,
      rtk: true,
    });
    await s.putRecord(TEAM);

    const { outcome } = await s.run();

    expect(outcome).toBe('applied');
    expect(s.setOf()).toEqual(D1_SET);
  });
});

describe('D4: a conflict that wrote the column recomputes the set', () => {
  it('keeps the local framework, takes the record list and writes the set for that column', async () => {
    const s = await setup({
      column: column(render({ framework: 'drupal10' })),
      base: BASE,
      set: P,
      claims: BASE_CLAIMS,
    });
    await s.putRecord(
      render({
        framework: 'drupal11',
        acceptedAgentIds: ['code-reviewer', 'security-auditor', 'test-writer'],
      }),
    );

    const { outcome } = await s.run();

    expect(outcome).toBe('conflict');
    const written = s.columnOf() as Json;
    expect(written.framework).toBe('drupal10');
    expect(written.acceptedAgentIds).toEqual(['code-reviewer', 'security-auditor', 'test-writer']);
    expect(s.setOf()).toEqual(D1_SET);
  });
});

describe("D5': the set is what the context renders, whatever it held and a claim records", () => {
  const CASES: { what: string; seed: Seed; checkout: ProjectRender; expected: string[] }[] = [
    {
      what: "D5'a: an RTK settings file the set held and a claim records leaves the set while RTK is off",
      seed: { set: P_WITH_RTK, claims: [...BASE_CLAIMS, RTK_CLAIM] },
      checkout: TEAM,
      expected: D1_SET,
    },
    {
      what: "D5'b: an id the set held that no live claim records goes, a superseded row being no claim",
      seed: { set: P_WITH_DOCS, claims: BASE_CLAIMS, retired: [DOCS_CLAIM] },
      checkout: TEAM,
      expected: D1_SET,
    },
    {
      what: "D5'c: a NULL set becomes what is rendered, not the claims",
      seed: { set: null, claims: BASE_CLAIMS },
      checkout: TEAM2,
      expected: TEAM2_SET,
    },
    {
      what: "D5'd: an RTK settings file a claim records and the set lacked stays out",
      seed: { set: P, claims: [...BASE_CLAIMS, RTK_CLAIM] },
      checkout: TEAM,
      expected: D1_SET,
    },
    {
      what: "D5'e: an agent the context stops rendering leaves the set, though a claim records it",
      seed: { set: P, claims: BASE_CLAIMS },
      checkout: TEAM2,
      expected: TEAM2_SET,
    },
  ];

  it.each(CASES)('$what', async ({ seed, checkout, expected }) => {
    const s = await setup({ column: column(BASE), base: BASE, rtk: false, ...seed });
    await s.putRecord(checkout);

    const { outcome } = await s.run();

    expect(outcome).toBe('applied');
    expect(s.setOf()).toEqual(expected);
  });
});

describe('D6: a repository with no claim keeps its set', () => {
  it('leaves a NULL set NULL, and sends one update of the repositories table, the column', async () => {
    const s = await setup({ column: column(BASE), base: BASE, set: null });
    await s.putRecord(TEAM);

    const { outcome, trace } = await s.run();

    expect(outcome).toBe('applied');
    expect(s.setOf()).toBeNull();
    expect(writesTo(trace, 'repositories')).toHaveLength(1);
  });

  it('leaves a set as it is, whatever it holds, when every row it had was superseded', async () => {
    const s = await setup({ column: column(BASE), base: BASE, set: P, retired: BASE_CLAIMS });
    await s.putRecord(TEAM);

    const { outcome, trace } = await s.run();

    expect(outcome).toBe('applied');
    expect(s.setOf()).toEqual(P);
    expect(writesTo(trace, 'repositories')).toHaveLength(1);
  });
});

describe('D7: a sync that does not write the column leaves the set alone', () => {
  // The column accepts test-writer and the set, deliberately stale, does not.
  const seed = (over: Seed): Seed => ({ claims: BASE_CLAIMS, set: P, ...over });
  const CASES: [string, Seed, (s: Setup) => Promise<void>, string][] = [
    [
      'unchanged',
      seed({ column: column(TEAM), base: TEAM }),
      (s) => s.putRecord(TEAM),
      'unchanged',
    ],
    [
      'unchanged with a moved base',
      seed({ column: column(TEAM), base: BASE }),
      (s) => s.putRecord(TEAM),
      'unchanged',
    ],
    [
      'a conflict with no write',
      seed({ column: column(render({ ...TEAM, framework: 'drupal10' })), base: TEAM }),
      (s) => s.putRecord(render({ ...TEAM, framework: 'drupal11' })),
      'conflict',
    ],
    [
      'deferred',
      seed({ column: column(TEAM), base: TEAM }),
      async (s) => {
        await s.putRecord(TEAM);
        s.addTask('onboarding_upgrade', 'running');
      },
      'deferred',
    ],
    [
      'superseded',
      seed({ column: column(TEAM), base: BASE }),
      async (s) => {
        await s.putRecord(TEAM);
        s.hook.onLock = () => s.patchBase(LATER);
      },
      'superseded',
    ],
    [
      'refused',
      seed({ column: column(TEAM), base: TEAM }),
      async (s) => {
        await s.putRecord(TEAM);
        await s.put(`${STATE_DIR}/project/render.json`, '{ "framework": \n');
      },
      'refused',
    ],
    ['absent', seed({ column: column(TEAM), base: TEAM }), async () => {}, 'absent'],
  ];

  it.each(CASES)('%s', async (_what, seeded, arrange, outcome) => {
    const s = await setup(seeded);
    await arrange(s);
    const before = s.rowOf();

    const { outcome: got, trace } = await s.run();

    expect(got).toBe(outcome);
    expect(s.setOf()).toEqual(P);
    expect(s.rowOf().updatedAt).toEqual(before.updatedAt);
    expect(writesTo(trace, 'repositories')).toEqual([]);
  });
});

describe('D8: the recompute and the column commit together or not at all', () => {
  const seeded = (): Seed => ({
    column: column(BASE),
    base: BASE,
    set: P,
    claims: BASE_CLAIMS,
    lastError: 'an earlier refusal',
  });

  it('D8a: runs in the one transaction, after the lock, and writes the set before the sync row', async () => {
    const s = await setup(seeded());
    await s.putRecord(TEAM);

    const { outcome, trace } = await s.run();

    expect(outcome).toBe('applied');
    expectWritesUnderTheLock(trace);
    const txn = transactions(trace).inside[0]!;
    expect(txn.filter((e) => e === 'update repositories')).toHaveLength(2);
    const columnAt = txn.indexOf('update repositories');
    const claimsAt = txn.indexOf('select onboarding_artifacts');
    const setAt = txn.lastIndexOf('update repositories');
    const syncRowAt = txn.findIndex((e) => /^(insert|update) project_state_sync$/.test(e));
    expect(columnAt).toBeGreaterThan(0);
    expect(claimsAt).toBeGreaterThan(columnAt);
    expect(setAt).toBeGreaterThan(claimsAt);
    expect(syncRowAt).toBeGreaterThan(setAt);
  });

  it('D8b: a set write that fails takes the column and the sync row back, and the sync rejects', async () => {
    const s = await setup(seeded());
    await s.putRecord(TEAM);
    const before = s.dump();
    s.hook.failRepositoryUpdate = 2;

    await expect(s.run()).rejects.toThrow('database refused');

    expect(s.dump()).toEqual(before);
    expect(s.syncRow()?.lastError).toBe('an earlier refusal');
  });

  it('D8c: a read of the custom bundles that fails takes the column and the sync row back, and the sync rejects', async () => {
    const s = await setup(seeded());
    await s.putRecord(TEAM);
    const before = s.dump();
    s.hook.failSelect = schema.customBundles;

    await expect(s.run()).rejects.toThrow('database refused');

    expect(s.dump()).toEqual(before);
    expect(s.syncRow()?.lastError).toBe('an earlier refusal');
  });
});

describe('D9: the sync and 01 resolve and expand through one module', () => {
  const SRC = fileURLToPath(new URL('../src/', import.meta.url));
  const codeOf = async (rel: string): Promise<string> =>
    (await readFile(join(SRC, rel), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const SYNC = 'project-state/sync.ts';
  const PLAN = 'step-engine/steps/onboarding-upgrade/01-upgrade-plan.ts';
  const importsFromRender = (code: string, name: string): boolean =>
    new RegExp(
      `import\\s*(?:type\\s*)?\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'[^']*/_upgrade-render\\.js'`,
    ).test(code);

  it.each([SYNC, PLAN])(
    '%s imports resolveRenderContext and unionExpandedFor from _upgrade-render',
    async (rel) => {
      const code = await codeOf(rel);
      expect(importsFromRender(code, 'resolveRenderContext')).toBe(true);
      expect(importsFromRender(code, 'unionExpandedFor')).toBe(true);
    },
  );

  it('01 defines neither of them', async () => {
    const code = await codeOf(PLAN);
    for (const name of ['resolveRenderContext', 'unionExpandedFor']) {
      expect(new RegExp(`\\b(?:function|const|let)\\s+${name}\\b`).test(code), name).toBe(false);
    }
  });

  it('the sync reads no applicable set: what it writes is what it renders', async () => {
    expect(/applicableTemplateIds/.test(await codeOf(SYNC))).toBe(false);
  });

  it('the sync calls none of the pieces they are made of', async () => {
    const code = await codeOf(SYNC);
    for (const name of [
      'renderContextFromColumn',
      'renderTargetsFor',
      'expandManifestFor',
      'expandCustomBundlesFor',
    ]) {
      expect(new RegExp(`\\b${name}\\b`).test(code), name).toBe(false);
    }
  });
});
