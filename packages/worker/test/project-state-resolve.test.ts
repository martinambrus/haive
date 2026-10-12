import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  conflictSide,
  emptyProjectState,
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
    rtkEnabled: false,
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
      rtkChoiceRecorded: true,
    });
    expect(await s.fileText()).toBe(renderText(MINE));
  });
});

describe('the whole render file as one question', () => {
  const rows = { '': { base: BASE, local: undefined, incoming: THEIRS } };

  it('has nothing of mine to keep', async () => {
    const s = await setup({ column: null, rows });
    expect(await s.answer('keep_mine', s.ids[''])).toEqual({ kind: 'no_local' });
    expect(s.rowOf(s.ids['']!).resolvedAt).toBeNull();
  });

  it('takes the teammate’s file as the column, with the RTK choice recorded', async () => {
    const s = await setup({ column: null, rows });

    const result = await s.answer('take_theirs', s.ids['']);

    expect(result.kind).toBe('resolved');
    expect(json(s.repoRow().renderContext)).toEqual({ ...THEIRS, rtkChoiceRecorded: true });
    expect(s.syncRow().baseSnapshot).toEqual(baseOf(THEIRS));
    expect((await sync(s)).outcome).toBe('unchanged');
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
