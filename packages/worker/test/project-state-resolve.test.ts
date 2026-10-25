import { DrizzleQueryError } from 'drizzle-orm/errors';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { normalizeContent, sha256Hex } from '@haive/shared';
import {
  claimFileName,
  conflictSide,
  emptyProjectState,
  isImportMarker,
  normalizeProjectState,
  renderProjectState,
  type ProjectRender,
  type ProjectStateAnswer,
  type ProjectStateRecord,
} from '@haive/shared/project-state';
import { resolveProjectStateConflict } from '../src/project-state/resolve.js';
import { syncProjectStateFromCheckout } from '../src/project-state/sync.js';

const OWNER = '00000000-0000-4000-8000-0000000000a1';
const STRANGER = '00000000-0000-4000-8000-0000000000a2';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';
const ONBOARDING = '00000000-0000-4000-8000-0000000000c1';

const RENDER_REL = '.haive-data/state/project/render.json';
const STATE_DIR = '.haive-data/state';
const HASH = 'a'.repeat(64);

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

type Json = Record<string, unknown>;
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

const render = (over: Partial<ProjectRender> = {}): ProjectRender => ({
  projectInfo: { name: 'acme', framework: 'drupal' },
  framework: 'drupal',
  acceptedAgentIds: ['code-reviewer', 'security-auditor'],
  customAgentSpecs: [],
  lspLanguages: ['php-extended'],
  ...over,
});
const BASE = render();
const MINE = render({ acceptedAgentIds: ['code-reviewer', 'docs-writer', 'security-auditor'] });
const THEIRS = render({ acceptedAgentIds: ['code-reviewer', 'security-auditor', 'test-writer'] });
const MINE_FW = 'drupal10';
const THEIRS_FW = 'drupal11';

const INSTALL = {
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
const column = (r: ProjectRender, over: Json = {}): Json => ({
  ...r,
  ...INSTALL,
  rtkChoiceRecorded: true,
  ...over,
});

const record = (r: ProjectRender | null): ProjectStateRecord => ({
  ...emptyProjectState(),
  render: r,
});
const baseOf = (r: ProjectRender): unknown => json(normalizeProjectState(record(r)));
const renderText = (r: ProjectRender): string =>
  renderProjectState(record(r)).get('project/render.json')!;

const PLUGIN_JSON =
  'plugin.drupal-php-lsp..claude/plugins/drupal-php-lsp/.claude-plugin/drupal-php-lsp/.claude-plugin/plugin.json';
const PLUGIN_LSP =
  'plugin.drupal-php-lsp..claude/plugins/drupal-php-lsp/.claude-plugin/drupal-php-lsp/.lsp.json';
const PLUGIN_MARKETPLACE =
  'plugin.drupal-php-lsp..claude/plugins/drupal-php-lsp/.claude-plugin/marketplace.json';
const WITH_DOCS = [
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
const WITH_TEST_WRITER = [
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
const CLAIMS: [string, string, string][] = [
  ['.claude/workflow-config.json', 'workflow-config', 'workflow-config'],
  ['.claude/agents/README.md', 'agents-index', 'agents-index'],
  ['.codex/agents/README.md', 'agents-index', 'agents-index'],
  ['.claude/agents/code-reviewer.md', 'agent.code-reviewer', 'agent'],
  ['.codex/agents/code-reviewer.toml', 'agent.code-reviewer', 'agent'],
  ['.claude/agents/security-auditor.md', 'agent.security-auditor', 'agent'],
  ['.codex/agents/security-auditor.toml', 'agent.security-auditor', 'agent'],
  [
    '.claude/plugins/drupal-php-lsp/.claude-plugin/marketplace.json',
    PLUGIN_MARKETPLACE,
    'plugin-file',
  ],
  [
    '.claude/plugins/drupal-php-lsp/.claude-plugin/drupal-php-lsp/.claude-plugin/plugin.json',
    PLUGIN_JSON,
    'plugin-file',
  ],
  [
    '.claude/plugins/drupal-php-lsp/.claude-plugin/drupal-php-lsp/.lsp.json',
    PLUGIN_LSP,
    'plugin-file',
  ],
  ['AGENTS.md', 'cli-rules', 'cli-rules-block'],
];

interface Seed {
  /** The column; `null` is a cleared one. */
  column?: Json | null;
  /** What the checkout's render file holds. */
  file?: ProjectRender;
  base?: ProjectRender;
  /** Pending rows, by key: base, local and incoming values (undefined = absent side). */
  rows?: Record<string, { base?: unknown; local?: unknown; incoming?: unknown }>;
  claims?: boolean;
}

const KEY = 'acceptedAgentIds';
const unitOf = (key: string) => `project/render.json#${key}`;

async function setup(seed: Seed = {}) {
  const root = await mkdtemp(join(tmpdir(), 'project-state-resolve-'));
  dirs.push(root);
  const { repositories, projectStateSync: sync, tasks, onboardingArtifacts } = schema;
  const conflicts = schema.projectStateConflicts;
  const fake = createFakeDb({
    projectStateOutbox: schema.projectStateOutbox,
    repositories,
    projectStateSync: sync,
    projectStateConflicts: conflicts,
    tasks,
    taskSteps: schema.taskSteps,
    onboardingArtifacts,
    cliProviders: schema.cliProviders,
    customBundles: schema.customBundles,
    customBundleItems: schema.customBundleItems,
  });
  fake.insert(repositories, {
    id: REPO,
    userId: OWNER,
    name: 'acme',
    source: 'git_https',
    status: 'ready',
    storagePath: root,
    // Holds no value, so the render-only checkouts below are coherent with it.
    rtkEnabled: null,
    renderContext: seed.column === undefined ? column(MINE) : seed.column,
    applicableTemplateIds: seed.claims ? WITH_DOCS : null,
    updatedAt: new Date(1000),
  });
  fake.insert(repositories, { id: OTHER, userId: OWNER, name: 'other', source: 'blank' });
  for (const [userId, name, enabled] of [
    [OWNER, 'claude-code', true],
    [OWNER, 'codex', true],
    [OWNER, 'gemini', false],
  ] as const) {
    fake.insert(schema.cliProviders, { userId, name, label: name, enabled, rulesContent: '' });
  }
  if (seed.claims) {
    fake.insert(tasks, {
      id: ONBOARDING,
      userId: OWNER,
      repositoryId: REPO,
      type: 'onboarding',
      status: 'completed',
      title: 'onboarding',
      completedAt: new Date(5000),
    });
    const snapshot = { ...BASE, ...INSTALL };
    for (const [diskPath, templateId, templateKind] of CLAIMS) {
      fake.insert(onboardingArtifacts, {
        userId: OWNER,
        repositoryId: REPO,
        taskId: ONBOARDING,
        diskPath,
        templateId,
        templateKind,
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
      });
    }
  }
  fake.insert(sync, {
    repositoryId: REPO,
    baseSnapshot: baseOf(seed.base ?? BASE),
    lastError: null,
    updatedAt: new Date(0),
  });
  const rows = seed.rows ?? { [KEY]: { base: BASE[KEY], local: MINE[KEY], incoming: THEIRS[KEY] } };
  const ids: Record<string, string> = {};
  for (const [key, sides] of Object.entries(rows)) {
    ids[key] = randomUUID();
    fake.insert(conflicts, {
      id: ids[key],
      repositoryId: REPO,
      unit: key === '' ? 'project/render.json' : unitOf(key),
      base: conflictSide(sides.base),
      local: conflictSide(sides.local),
      incoming: conflictSide(sides.incoming),
      detectedAt: new Date(2000),
      resolution: null,
      resolvedAt: null,
      resolvedBy: null,
    });
  }
  const file = seed.file ?? THEIRS;
  await mkdir(dirname(join(root, RENDER_REL)), { recursive: true });
  for (const [rel, text] of renderProjectState(record(file))) {
    await mkdir(dirname(join(root, STATE_DIR, rel)), { recursive: true });
    await writeFile(join(root, STATE_DIR, rel), text);
  }

  const locks: string[] = [];
  fake.hooks.beforeLock = (key) => {
    locks.push(key);
  };
  const db = fake.db as unknown as Database;
  const answer = (a: ProjectStateAnswer, id = ids[KEY], userId = OWNER, repositoryId = REPO) =>
    resolveProjectStateConflict(db, { repositoryId, userId, conflictId: id!, answer: a });
  const rowOf = (id: string) => fake.rows(conflicts).find((r) => r.id === id)!;
  const repoRow = () => fake.rows(repositories).find((r) => r.id === REPO)!;
  const syncRow = () => fake.rows(sync).find((r) => r.repositoryId === REPO)!;
  const fileText = () => readFile(join(root, RENDER_REL), 'utf8');
  const dump = () =>
    json({
      repositories: fake.rows(repositories),
      projectStateSync: fake.rows(sync),
      projectStateConflicts: fake.rows(conflicts),
    });
  const addTask = (type: string, status: string, repositoryId = REPO) =>
    fake.insert(tasks, { id: randomUUID(), userId: OWNER, repositoryId, type, status, title: 't' });
  return { root, fake, db, ids, locks, answer, rowOf, repoRow, syncRow, fileText, dump, addTask };
}

const sync = (s: Awaited<ReturnType<typeof setup>>) =>
  syncProjectStateFromCheckout(s.db, { repositoryId: REPO, repoPath: s.root });

describe('answering a conflict: keep mine', () => {
  it('leaves the column, writes my value to the file and the base, and closes the row', async () => {
    const s = await setup();
    const columnBefore = json(s.repoRow().renderContext);

    const result = await s.answer('keep_mine');

    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') return;
    expect(result.written).toEqual([RENDER_REL]);
    expect(result.conflict).toMatchObject({
      id: s.ids[KEY],
      key: KEY,
      resolution: 'keep_mine',
      local: { present: true, value: MINE[KEY] },
      incoming: { present: true, value: THEIRS[KEY] },
    });
    expect(json(s.repoRow().renderContext)).toEqual(columnBefore);
    expect(await s.fileText()).toBe(renderText(MINE));
    expect(s.syncRow().baseSnapshot).toEqual(baseOf(MINE));
    expect(s.syncRow().lastError).toBeNull();
    const row = s.rowOf(s.ids[KEY]!);
    expect(row).toMatchObject({ resolution: 'keep_mine', resolvedBy: OWNER });
    expect(row.resolvedAt).toBeInstanceOf(Date);
  });

  it('is met by no conflict and no write on the next sync', async () => {
    const s = await setup();
    await s.answer('keep_mine');
    await sync(s); // Import the newly answered bytes; later syncs are idempotent.
    const before = s.dump();

    const next = await sync(s);

    expect(next.outcome).toBe('unchanged');
    expect(s.dump()).toEqual(before);
  });

  it('does not recompute the applicable template ids, since the column did not move', async () => {
    const s = await setup({ claims: true });
    await s.answer('keep_mine');
    expect(s.repoRow().applicableTemplateIds).toEqual(WITH_DOCS);
  });
});

describe('answering a conflict: take theirs', () => {
  it('moves the column key, keeps the per-install fields, and leaves the file as it is', async () => {
    const s = await setup();
    const fileBefore = await s.fileText();

    const result = await s.answer('take_theirs');

    expect(result).toMatchObject({ kind: 'resolved', written: [] });
    expect(json(s.repoRow().renderContext)).toEqual(json(column(THEIRS)));
    expect(await s.fileText()).toBe(fileBefore);
    expect(s.syncRow().baseSnapshot).toEqual(baseOf(THEIRS));
    expect(s.rowOf(s.ids[KEY]!)).toMatchObject({ resolution: 'take_theirs', resolvedBy: OWNER });
  });

  it('recomputes the applicable template ids from the new column', async () => {
    const s = await setup({ claims: true });
    expect(s.repoRow().applicableTemplateIds).toEqual(WITH_DOCS);

    await s.answer('take_theirs');

    expect(s.repoRow().applicableTemplateIds).toEqual(WITH_TEST_WRITER);
  });

  it('is met by no conflict and no write on the next sync', async () => {
    const s = await setup();
    await s.answer('take_theirs');
    await sync(s); // Stamp the acknowledged checkout independently of the merge base.
    const before = s.dump();

    expect((await sync(s)).outcome).toBe('unchanged');
    expect(s.dump()).toEqual(before);
  });
});

describe('answering one of several conflicts', () => {
  const rows = {
    [KEY]: { base: BASE[KEY], local: MINE[KEY], incoming: THEIRS[KEY] },
    framework: { base: BASE.framework, local: MINE_FW, incoming: THEIRS_FW },
  };
  const seed = (): Seed => ({
    column: column({ ...MINE, framework: MINE_FW }),
    file: { ...THEIRS, framework: THEIRS_FW },
    rows,
  });

  it('keeps the other key at the teammate’s value in the file and at its old base, and still pending', async () => {
    const s = await setup(seed());

    await s.answer('keep_mine');

    expect(JSON.parse(await s.fileText())).toMatchObject({
      [KEY]: MINE[KEY],
      framework: THEIRS_FW,
    });
    expect(s.syncRow().baseSnapshot).toEqual(baseOf({ ...BASE, [KEY]: MINE[KEY] }));
    expect(s.rowOf(s.ids.framework!).resolvedAt).toBeNull();
    expect(s.syncRow().lastError).toBe(
      "render context conflicts with the checkout's record: framework",
    );
  });

  it('leaves the next sync one question, the one not answered', async () => {
    const s = await setup(seed());
    await s.answer('take_theirs');

    const next = await sync(s);

    expect(next.outcome).toBe('conflict');
    const pending = s.fake
      .rows(schema.projectStateConflicts)
      .filter((r) => r.resolvedAt == null)
      .map((r) => r.unit);
    expect(pending).toEqual([unitOf('framework')]);
  });
});

describe('answering twice', () => {
  it('the same answer returns the closed row again and writes nothing', async () => {
    const s = await setup();
    const first = await s.answer('take_theirs');
    const before = s.dump();

    const again = await s.answer('take_theirs');

    expect(again).toMatchObject({ kind: 'resolved', written: [] });
    if (first.kind === 'resolved' && again.kind === 'resolved') {
      expect(again.conflict).toEqual(first.conflict);
    }
    expect(s.dump()).toEqual(before);
  });

  it('a different answer is refused as settled, and nothing changes', async () => {
    const s = await setup();
    await s.answer('take_theirs');
    const before = s.dump();

    expect(await s.answer('keep_mine')).toEqual({ kind: 'settled', resolution: 'take_theirs' });
    expect(s.dump()).toEqual(before);
  });

  it('a row the teammate already converged is settled for either answer', async () => {
    const s = await setup();
    s.fake.patch(schema.projectStateConflicts, s.ids[KEY]!, {
      resolution: 'converged',
      resolvedAt: new Date(3000),
    });
    expect(await s.answer('keep_mine')).toEqual({ kind: 'settled', resolution: 'converged' });
    expect(await s.answer('take_theirs')).toEqual({ kind: 'settled', resolution: 'converged' });
  });
});

describe('a checkout whose record moved', () => {
  it('is refused and the file, column and base stay, then the row is re-synced to the new value', async () => {
    const s = await setup();
    const NEWER = render({ acceptedAgentIds: ['code-reviewer', 'qa-lead', 'security-auditor'] });
    await writeFile(join(s.root, RENDER_REL), renderText(NEWER));
    const columnBefore = json(s.repoRow().renderContext);
    const baseBefore = s.syncRow().baseSnapshot;

    const result = await s.answer('take_theirs');

    expect(result).toEqual({ kind: 'moved' });
    expect(json(s.repoRow().renderContext)).toEqual(columnBefore);
    expect(await s.fileText()).toBe(renderText(NEWER));
    expect(s.syncRow().baseSnapshot).toEqual(baseBefore);
    const row = s.rowOf(s.ids[KEY]!);
    expect(row.resolvedAt).toBeNull();
    expect(row.incoming).toEqual({ v: NEWER[KEY] });
  });

  it('is refused when the render file is gone', async () => {
    const s = await setup();
    await rm(join(s.root, RENDER_REL));
    expect(await s.answer('keep_mine')).toEqual({ kind: 'moved' });
    expect(s.rowOf(s.ids[KEY]!).resolvedAt).toBeNull();
  });

  it('is refused when the render file is a link, which is never followed', async () => {
    const s = await setup();
    const outside = join(s.root, 'elsewhere.json');
    await writeFile(outside, renderText(THEIRS));
    await rm(join(s.root, RENDER_REL));
    await symlink(outside, join(s.root, RENDER_REL));

    expect(await s.answer('keep_mine')).toEqual({ kind: 'moved' });
    expect(s.rowOf(s.ids[KEY]!).resolvedAt).toBeNull();
  });
});

describe('a repository with a live onboarding or upgrade', () => {
  for (const [type, status] of [
    ['onboarding', 'running'],
    ['onboarding_upgrade', 'waiting_user'],
    ['onboarding_upgrade', 'queued'],
  ] as const) {
    it(`refuses while a ${type} is ${status}, and writes nothing`, async () => {
      const s = await setup();
      s.addTask(type, status);
      const before = s.dump();
      const fileBefore = await s.fileText();

      expect(await s.answer('keep_mine')).toEqual({ kind: 'busy' });
      expect(s.dump()).toEqual(before);
      expect(await s.fileText()).toBe(fileBefore);
    });
  }

  it('answers when the task is dead, whatever status it keeps', async () => {
    const s = await setup();
    s.fake.insert(schema.tasks, {
      id: randomUUID(),
      userId: OWNER,
      repositoryId: REPO,
      type: 'onboarding_upgrade',
      status: 'running',
      title: 't',
      deadAt: new Date(),
    });
    expect((await s.answer('keep_mine')).kind).toBe('resolved');
  });

  it('answers when the task is finished, never enqueued, or another repository’s', async () => {
    const s = await setup();
    s.addTask('onboarding_upgrade', 'completed');
    s.addTask('onboarding_upgrade', 'created');
    s.addTask('onboarding_upgrade', 'running', OTHER);
    expect((await s.answer('keep_mine')).kind).toBe('resolved');
  });
});

describe('who may answer', () => {
  it('is the repository’s owner, and the row must belong to that repository', async () => {
    const s = await setup();
    expect(await s.answer('keep_mine', s.ids[KEY], STRANGER)).toEqual({ kind: 'not_found' });
    expect(await s.answer('keep_mine', s.ids[KEY], OWNER, OTHER)).toEqual({ kind: 'not_found' });
    expect(await s.answer('keep_mine', randomUUID())).toEqual({ kind: 'not_found' });
    expect(s.rowOf(s.ids[KEY]!).resolvedAt).toBeNull();
  });

  it('takes the project-state lock the writer and the sync take', async () => {
    const s = await setup();
    await s.answer('keep_mine');
    expect(s.locks).toContain(`project-state:${REPO}`);
  });
});

describe('a cleared column', () => {
  it('is rebuilt from the file and the row’s local side when mine is kept', async () => {
    const s = await setup({ column: null });

    const result = await s.answer('keep_mine');

    expect(result.kind).toBe('resolved');
    expect(json(s.repoRow().renderContext)).toMatchObject({
      ...MINE,
      rtkChoiceRecorded: false,
    });
    expect(await s.fileText()).toBe(renderText(MINE));
  });

  it('is rebuilt with no RTK choice when theirs is taken', async () => {
    const s = await setup({ column: null });

    const result = await s.answer('take_theirs');

    expect(result.kind).toBe('resolved');
    expect(json(s.repoRow().renderContext)).toMatchObject({ rtkChoiceRecorded: false });
  });
});

describe('a column an answer created, which records no RTK choice', () => {
  const RTK_FILE = join(STATE_DIR, 'settings/rtk-enabled.json');
  const wholeFile = { '': { base: BASE, local: undefined, incoming: THEIRS } };
  const paths: [string, () => Promise<Awaited<ReturnType<typeof setup>>>, string][] = [
    [
      'keeping mine for one key',
      async () => {
        const s = await setup({ column: null });
        await s.answer('keep_mine');
        return s;
      },
      'keep_mine',
    ],
    [
      'taking theirs for one key',
      async () => {
        const s = await setup({ column: null });
        await s.answer('take_theirs');
        return s;
      },
      'take_theirs',
    ],
    [
      'taking the whole file',
      async () => {
        const s = await setup({ column: null, rows: wholeFile });
        await s.answer('take_theirs', s.ids['']);
        return s;
      },
      'take_theirs',
    ],
  ];

  it.each(paths)(
    'stays as it is on the next sync of a record with no file, after %s',
    async (_name, make) => {
      const s = await make();
      expect((json(s.repoRow().renderContext) as Json).rtkChoiceRecorded).toBe(false);
      s.fake.patch(schema.repositories, REPO, { rtkEnabled: true });
      await sync(s);
      const before = s.dump();

      expect((await sync(s)).outcome).toBe('unchanged');

      expect(s.dump()).toEqual(before);
    },
  );

  it.each(paths)(
    'adopts the file a record carries on the next sync, after %s',
    async (_name, make) => {
      const s = await make();
      expect((json(s.repoRow().renderContext) as Json).rtkChoiceRecorded).toBe(false);
      s.fake.patch(schema.repositories, REPO, { rtkEnabled: true });
      await mkdir(dirname(join(s.root, RTK_FILE)), { recursive: true });
      await writeFile(join(s.root, RTK_FILE), 'false\n');

      expect((await sync(s)).outcome).toBe('applied');

      expect((json(s.repoRow().renderContext) as Json).rtkChoiceRecorded).toBe(true);
      expect(s.repoRow().rtkEnabled).toBe(false);
    },
  );
});

describe('the whole render file as one question', () => {
  const rows = { '': { base: BASE, local: undefined, incoming: THEIRS } };

  it('has nothing of mine to keep', async () => {
    const s = await setup({ column: null, rows });
    expect(await s.answer('keep_mine', s.ids[''])).toEqual({ kind: 'no_local' });
    expect(s.rowOf(s.ids['']!).resolvedAt).toBeNull();
  });

  it('takes the teammate’s file as the column, with no RTK choice recorded', async () => {
    const s = await setup({ column: null, rows });

    const result = await s.answer('take_theirs', s.ids['']);

    expect(result.kind).toBe('resolved');
    expect(json(s.repoRow().renderContext)).toEqual({ ...THEIRS, rtkChoiceRecorded: false });
    expect(s.syncRow().baseSnapshot).toEqual(baseOf(THEIRS));
    expect((await sync(s)).outcome).toBe('unchanged');
  });
});

describe('serialised with a pull', () => {
  it('takes the plan-merge lock a pull lands the checkout under, before the project-state lock', async () => {
    const s = await setup();

    await s.answer('take_theirs');

    const merge = s.locks.indexOf(`plan-merge:${REPO}`);
    expect(merge).toBeGreaterThanOrEqual(0);
    expect(merge).toBeLessThan(s.locks.indexOf(`project-state:${REPO}`));
  });
});

describe('a render file that changed under the answer', () => {
  it('answers moved and leaves a file someone rewrote after it was read', async () => {
    const s = await setup();
    const theirsEdit = JSON.stringify({ ...THEIRS, framework: 'laravel' }, null, 2);
    s.fake.hooks.beforeInsert = async (table) => {
      if (table === schema.projectStateSync) await writeFile(join(s.root, RENDER_REL), theirsEdit);
    };

    const result = await s.answer('keep_mine');

    expect(result.kind).toBe('moved');
    expect(await s.fileText()).toBe(theirsEdit);
    expect(s.rowOf(s.ids[KEY]!).resolvedAt).toBeNull();
  });

  it('answers moved when take theirs finds the file changed before it commits', async () => {
    const s = await setup();
    const newer = JSON.stringify({ ...THEIRS, framework: 'laravel' }, null, 2);
    s.fake.hooks.beforeInsert = async (table) => {
      if (table === schema.projectStateSync) await writeFile(join(s.root, RENDER_REL), newer);
    };

    const result = await s.answer('take_theirs');

    expect(result.kind).toBe('moved');
    expect(s.rowOf(s.ids[KEY]!).resolvedAt).toBeNull();
  });

  it('answers moved for a render file that is not valid UTF-8', async () => {
    const s = await setup();
    const bytes = Buffer.from(JSON.stringify(THEIRS, null, 2), 'utf8');
    const at = bytes.indexOf('"framework"') + 1;
    const bad = Buffer.concat([bytes.subarray(0, at), Buffer.from([0xff]), bytes.subarray(at)]);
    await writeFile(join(s.root, RENDER_REL), bad);

    const result = await s.answer('keep_mine');

    expect(result.kind).toBe('moved');
    expect(Buffer.compare(await readFile(join(s.root, RENDER_REL)), bad)).toBe(0);
  });
});

describe('a failure after the file would be rewritten', () => {
  it.each(['ordinary', 'bound-original', 'bound-put-back'] as const)(
    'recovery preserves ordinary String diagnostics and hides bound members: %s',
    async (shape) => {
      const s = await setup();
      const secret = 'RECOVERY_BOUND_SECRET_426';
      const bound = () =>
        new DrizzleQueryError('update fixture set value = $1', [secret], new Error(secret));
      const original = shape === 'bound-original' ? bound() : new TypeError('original\n  failure');
      const putBack = shape === 'bound-put-back' ? bound() : new RangeError('put-back\n  failure');
      let commits = 0;
      s.fake.hooks.beforeCommit = () => {
        // The first transaction reached the file rewrite; the second reached the put-back.
        throw ++commits === 1 ? original : putBack;
      };
      const err = await s.answer('keep_mine').catch((error: unknown) => error);
      expect(commits).toBe(2);
      expect(err).toBeInstanceOf(AggregateError);
      const aggregate = err as AggregateError;
      expect(aggregate.errors).toEqual([original, putBack]);
      expect(aggregate.message).toBe(
        `${shape === 'bound-original' ? 'Database operation failed' : String(original)}; putting the render file's bytes back failed too: ${shape === 'bound-put-back' ? 'Database operation failed' : String(putBack)}`,
      );
      expect(aggregate.message.includes(secret)).toBe(false);
      expect(s.rowOf(s.ids[KEY]!).resolvedAt).toBeNull();
    },
  );

  const failures: [string, (s: Awaited<ReturnType<typeof setup>>) => void][] = [
    [
      'the commit',
      (s) => {
        s.fake.hooks.beforeCommit = () => {
          throw new Error('commit failed');
        };
      },
    ],
    [
      'closing the row',
      (s) => {
        s.fake.hooks.beforeUpdate = (table) => {
          if (table === schema.projectStateConflicts) throw new Error('update failed');
        };
      },
    ],
    [
      'writing the sync base',
      (s) => {
        s.fake.hooks.beforeInsert = (table) => {
          if (table === schema.projectStateSync) throw new Error('insert failed');
        };
      },
    ],
  ];

  it.each(failures)(
    'leaves render.json byte-identical, the row pending and the column and base as they were when %s fails',
    async (_name, fail) => {
      const s = await setup();
      const original = JSON.stringify(THEIRS, null, 4);
      await writeFile(join(s.root, RENDER_REL), original);
      const before = s.dump();
      fail(s);

      await expect(s.answer('keep_mine')).rejects.toThrow();

      expect(await s.fileText()).toBe(original);
      expect(s.dump()).toEqual(before);
      expect(s.rowOf(s.ids[KEY]!).resolvedAt).toBeNull();
    },
  );

  it('leaves the answer in place when the commit landed but its acknowledgement was lost', async () => {
    const s = await setup();
    const db = s.fake.db as unknown as { transaction: (fn: unknown) => Promise<unknown> };
    const commit = db.transaction.bind(db);
    let first = true;
    db.transaction = async (fn) => {
      const out = await commit(fn);
      if (!first) return out;
      first = false;
      throw new Error('connection lost after COMMIT');
    };

    await expect(s.answer('keep_mine')).rejects.toThrow();

    expect(await s.fileText()).toBe(renderText(MINE));
  });

  it('leaves a file someone changed after the failed answer wrote it', async () => {
    const s = await setup();
    const theirs = JSON.stringify({ ...THEIRS, framework: 'laravel' }, null, 2);
    s.fake.hooks.beforeCommit = async () => {
      s.fake.hooks.beforeCommit = null;
      await writeFile(join(s.root, RENDER_REL), theirs);
      throw new Error('commit failed');
    };

    await expect(s.answer('keep_mine')).rejects.toThrow();

    expect(await s.fileText()).toBe(theirs);
    expect(s.rowOf(s.ids[KEY]!).resolvedAt).toBeNull();
  });

  it('answers once the failure is gone, and the next sync finds nothing to ask', async () => {
    const s = await setup();
    s.fake.hooks.beforeCommit = () => {
      throw new Error('commit failed');
    };
    await expect(s.answer('keep_mine')).rejects.toThrow();
    s.fake.hooks.beforeCommit = null;

    expect((await s.answer('keep_mine')).kind).toBe('resolved');
    expect(await s.fileText()).toBe(renderText(MINE));
    expect((await sync(s)).outcome).toBe('unchanged');
  });
});

describe('a claim question', () => {
  const CPATH = 'docs/guide.md';
  const CUNIT = claimFileName(CPATH);
  const CREL = `${STATE_DIR}/${CUNIT}`;
  const DISK_TEXT = 'the guide as the teammate wrote it\n';
  const DISK_HASH = sha256Hex(normalizeContent(DISK_TEXT));
  const claim = (writtenHash: string, over: Json = {}) => ({
    path: CPATH,
    templateId: 'workflow-config',
    kind: 'workflow-config',
    schemaVersion: 1,
    templateHash: 'c'.repeat(64),
    writtenHash,
    haiveVersion: '1.2.3',
    ...over,
  });
  const CBASE = claim('1'.repeat(64));
  const CMINE = claim('2'.repeat(64));
  const CTHEIRS = claim(DISK_HASH);
  const claimText = (c: unknown): string =>
    renderProjectState({ ...emptyProjectState(), claims: [c as never] }).get(CUNIT)!;

  async function claimSetup(
    over: {
      local?: unknown;
      incoming?: unknown;
      file?: string | null;
      disk?: string | null;
    } = {},
  ) {
    const s = await setup({ rows: {} });
    const incoming = 'incoming' in over ? over.incoming : CTHEIRS;
    const local = 'local' in over ? over.local : CMINE;
    const id = randomUUID();
    s.fake.insert(schema.projectStateConflicts, {
      id,
      repositoryId: REPO,
      unit: CUNIT,
      base: conflictSide(CBASE),
      local: conflictSide(local),
      incoming: conflictSide(incoming),
      detectedAt: new Date(2000),
      resolution: null,
      resolvedAt: null,
      resolvedBy: null,
    });
    if (local !== undefined) {
      const c = local as ReturnType<typeof claim>;
      s.fake.insert(schema.onboardingArtifacts, {
        id: randomUUID(),
        userId: OWNER,
        repositoryId: REPO,
        taskId: ONBOARDING,
        diskPath: c.path,
        templateId: c.templateId,
        templateKind: c.kind,
        templateSchemaVersion: c.schemaVersion,
        templateContentHash: c.templateHash,
        writtenHash: c.writtenHash,
        userModified: false,
        sourceStepId: '12-post-onboarding',
        source: 'onboarding',
        haiveVersion: c.haiveVersion,
        generatedAt: new Date(5000),
        supersededAt: null,
      });
    }
    const file = 'file' in over ? over.file : claimText(incoming);
    if (file !== null && file !== undefined) {
      await mkdir(dirname(join(s.root, CREL)), { recursive: true });
      await writeFile(join(s.root, CREL), file);
    }
    if (over.disk !== undefined && over.disk !== null) {
      await mkdir(dirname(join(s.root, CPATH)), { recursive: true });
      await writeFile(join(s.root, CPATH), over.disk);
    }
    const ledger = () => s.fake.rows(schema.onboardingArtifacts) as Record<string, unknown>[];
    const claimFileText = () => readFile(join(s.root, CREL), 'utf8');
    const baseClaims = () => (s.syncRow().baseSnapshot as { claims: unknown[] }).claims;
    return { ...s, id, ledger, claimFileText, baseClaims };
  }

  it('keep mine writes my claim to the file and the base and leaves the ledger as it is', async () => {
    const s = await claimSetup();
    const ledgerBefore = json(s.ledger());
    const columnBefore = json(s.repoRow().renderContext);

    const result = await s.answer('keep_mine', s.id);

    expect(result).toMatchObject({ kind: 'resolved', written: [CREL] });
    expect(await s.claimFileText()).toBe(claimText(CMINE));
    expect(s.baseClaims()).toEqual([CMINE]);
    expect(json(s.ledger())).toEqual(ledgerBefore);
    expect(json(s.repoRow().renderContext)).toEqual(columnBefore);
    expect(s.rowOf(s.id)).toMatchObject({ resolution: 'keep_mine', resolvedBy: OWNER });
  });

  it('keep mine writes the file anew where the teammate removed the claim', async () => {
    const s = await claimSetup({ incoming: undefined, file: null });

    const result = await s.answer('keep_mine', s.id);

    expect(result).toMatchObject({ kind: 'resolved', written: [CREL] });
    expect(await s.claimFileText()).toBe(claimText(CMINE));
  });

  it('keep mine has nothing to keep where this install holds no such claim', async () => {
    const s = await claimSetup({ local: undefined });
    expect(await s.answer('keep_mine', s.id)).toEqual({ kind: 'no_local' });
    expect(s.rowOf(s.id).resolvedAt).toBeNull();
  });

  it('take theirs retires my row and records their claim as an import marker', async () => {
    const s = await claimSetup({ disk: DISK_TEXT });
    const fileBefore = await s.claimFileText();

    const result = await s.answer('take_theirs', s.id);

    expect(result).toMatchObject({ kind: 'resolved', written: [] });
    const rows = s.ledger();
    const mine = rows.find((r) => r.taskId === ONBOARDING)!;
    expect(mine.supersededAt).toBeInstanceOf(Date);
    expect(mine.importedAt).toBeInstanceOf(Date);
    const live = rows.filter((r) => r.supersededAt == null);
    expect(live).toHaveLength(1);
    const marker = live[0]!;
    expect(isImportMarker(marker as never)).toBe(true);
    expect(marker.taskId == null).toBe(true);
    expect(marker.importedAt).toBeInstanceOf(Date);
    expect(marker.importedAt).toEqual(marker.generatedAt);
    expect(marker).toMatchObject({
      userId: OWNER,
      repositoryId: REPO,
      diskPath: CPATH,
      templateId: 'workflow-config',
      templateKind: 'workflow-config',
      templateSchemaVersion: 1,
      templateContentHash: CTHEIRS.templateHash,
      writtenHash: DISK_HASH,
      writtenContent: DISK_TEXT,
      lastObservedDiskHash: DISK_HASH,
      userModified: false,
      source: 'backfill',
      sourceStepId: 'project-state-import',
      haiveVersion: '1.2.3',
      bundleItemId: null,
    });
    expect(marker.formValuesSnapshot).toMatchObject({ framework: 'drupal' });
    expect(marker.formValuesSnapshot).not.toHaveProperty('rtkChoiceRecorded');
    expect(s.baseClaims()).toEqual([CTHEIRS]);
    expect(await s.claimFileText()).toBe(fileBefore);
    expect(s.repoRow().applicableTemplateIds).toEqual(expect.any(Array));
    expect(s.rowOf(s.id)).toMatchObject({ resolution: 'take_theirs', resolvedBy: OWNER });
  });

  it('gives a marker for an agent a snapshot that accepts the agent', async () => {
    const theirs = claim(DISK_HASH, { templateId: 'agent.qa-lead', kind: 'agent' });
    const s = await claimSetup({ incoming: theirs, disk: DISK_TEXT });

    await s.answer('take_theirs', s.id);

    const marker = s.ledger().find((r) => r.supersededAt == null)!;
    expect((marker.formValuesSnapshot as { acceptedAgentIds: string[] }).acceptedAgentIds).toEqual([
      'code-reviewer',
      'docs-writer',
      'qa-lead',
      'security-auditor',
    ]);
  });

  it('keeps no bytes in the marker when the disk does not hold their claim', async () => {
    const s = await claimSetup({ disk: 'something else\n' });

    await s.answer('take_theirs', s.id);

    const marker = s.ledger().find((r) => r.taskId == null)!;
    expect(marker.writtenContent).toBeNull();
    expect(marker.lastObservedDiskHash).toBe(sha256Hex(normalizeContent('something else\n')));
  });

  it('keeps no observed hash in the marker when the path is absent', async () => {
    const s = await claimSetup();

    await s.answer('take_theirs', s.id);

    const marker = s.ledger().find((r) => r.taskId == null)!;
    expect(marker.writtenContent).toBeNull();
    expect(marker.lastObservedDiskHash).toBeNull();
  });

  it('records a custom template this install cannot map under the portable id it was sent', async () => {
    const portable = 'custom:zip%3Aacme-kit:agents%2Fbilling.md';
    const theirs = claim(DISK_HASH, { templateId: portable, kind: 'custom-agent' });
    const s = await claimSetup({ incoming: theirs });

    await s.answer('take_theirs', s.id);

    const marker = s.ledger().find((r) => r.taskId == null)!;
    expect(marker).toMatchObject({ templateId: portable, bundleItemId: null });
  });

  it('take theirs retires my row and adds no marker where the teammate removed the claim', async () => {
    const s = await claimSetup({ incoming: undefined, file: null });

    const result = await s.answer('take_theirs', s.id);

    expect(result).toMatchObject({ kind: 'resolved', written: [] });
    const rows = s.ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.supersededAt).toBeInstanceOf(Date);
    expect(rows[0]!.importedAt).toBeInstanceOf(Date);
    expect(s.baseClaims()).toEqual([]);
    expect(existsSync(join(s.root, CREL))).toBe(false);
  });

  it('is moved, and re-asked against the file, when it no longer holds their claim', async () => {
    const newer = claim('9'.repeat(64));
    const s = await claimSetup({ file: claimText(newer) });
    const ledgerBefore = json(s.ledger());

    expect(await s.answer('take_theirs', s.id)).toEqual({ kind: 'moved' });

    expect(json(s.ledger())).toEqual(ledgerBefore);
    expect(s.rowOf(s.id).resolvedAt).toBeNull();
    expect(s.rowOf(s.id).incoming).toEqual({ v: newer });
    expect(await s.claimFileText()).toBe(claimText(newer));
  });

  it('is moved for keep mine too, and writes nothing', async () => {
    const s = await claimSetup({ file: claimText(claim('9'.repeat(64))) });
    const fileBefore = await s.claimFileText();

    expect(await s.answer('keep_mine', s.id)).toEqual({ kind: 'moved' });

    expect(await s.claimFileText()).toBe(fileBefore);
    expect(s.rowOf(s.id).resolvedAt).toBeNull();
  });

  it('is moved when their claim was a removal and the file is back', async () => {
    const s = await claimSetup({ incoming: undefined, file: claimText(CTHEIRS) });
    expect(await s.answer('take_theirs', s.id)).toEqual({ kind: 'moved' });
    expect(s.rowOf(s.id).resolvedAt).toBeNull();
  });

  it('is moved for a claim file that is gone', async () => {
    const s = await claimSetup({ file: null });
    expect(await s.answer('keep_mine', s.id)).toEqual({ kind: 'moved' });
  });

  it('leaves a claim file someone rewrote after it was read, and answers moved', async () => {
    const s = await claimSetup();
    const edited = claimText(claim('8'.repeat(64)));
    s.fake.hooks.beforeInsert = async (table) => {
      if (table === schema.projectStateSync) await writeFile(join(s.root, CREL), edited);
    };

    expect((await s.answer('keep_mine', s.id)).kind).toBe('moved');
    expect(await s.claimFileText()).toBe(edited);
    expect(s.rowOf(s.id).resolvedAt).toBeNull();
  });

  it('puts the previous bytes back when a later step of the answer fails', async () => {
    const s = await claimSetup();
    const before = await s.claimFileText();
    s.fake.hooks.beforeCommit = () => {
      throw new Error('commit failed');
    };

    await expect(s.answer('keep_mine', s.id)).rejects.toThrow();

    expect(await s.claimFileText()).toBe(before);
    expect(s.rowOf(s.id).resolvedAt).toBeNull();
  });

  it('answering twice returns the closed row again and writes nothing', async () => {
    const s = await claimSetup();
    await s.answer('take_theirs', s.id);
    const before = s.dump();

    expect(await s.answer('take_theirs', s.id)).toMatchObject({ kind: 'resolved', written: [] });
    expect(await s.answer('keep_mine', s.id)).toEqual({
      kind: 'settled',
      resolution: 'take_theirs',
    });
    expect(s.dump()).toEqual(before);
  });
});

it('fix4 sanitizes both failures when resolving and putting back fail', async () => {
  const s = await setup();
  const secret = randomBytes(24).toString('base64url');
  s.fake.hooks.beforeCommit = () => {
    throw new DrizzleQueryError('select $1', [secret], new Error(secret));
  };
  const err = await s.answer('keep_mine').catch((err: unknown) => err);
  expect(err instanceof AggregateError).toBe(true);
  expect(
    Array.from({ length: secret.length - 5 }, (_, i) => secret.slice(i, i + 6)).some((part) =>
      (err as Error).message.includes(part),
    ),
  ).toBe(false);
});
