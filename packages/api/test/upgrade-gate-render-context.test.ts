import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: h.add }) }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { KB_DIR } from '@haive/shared/knowledge-paths';
import * as onboardingState from '../src/lib/onboarding-state.js';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const { LIVE_TASK_STATUSES } = onboardingState;

/**
 * B1.4c controls A0-A11 and the pins P1-P4 (design-c.md "Controls"): POST /tasks starts an upgrade on a
 * repository whose render context column 01 would plan from and that GET /repos shows as onboarded, and
 * on no other that the two terms it already had refuse. The fake database evaluates its filters, so
 * every state of the verdict (live onboarding, reset epoch, status, markers) is real here.
 */
const REPO = '00000000-0000-4000-8000-0000000000c1';
const NO_ONBOARDING = 'No completed onboarding found for this repository; cannot upgrade';

const app = new Hono<AppEnv>();
app.use(async (c, next) => {
  c.set('maintenanceState', 'normal');
  await next();
});
app.route('/tasks', taskRoutes);
app.onError(errorHandler);

beforeEach(() => {
  h.add.mockReset();
  h.add.mockResolvedValue(undefined);
});

const startUpgrade = () =>
  app.request('/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'onboarding_upgrade', title: 'Upgrade', repositoryId: REPO }),
  });

/** What the sync writes into a clone's column: the five portable fields and the stored RTK flag. */
const portableOnly = () => ({
  projectInfo: { name: 'acme' },
  framework: 'drupal',
  acceptedAgentIds: ['code-reviewer'],
  customAgentSpecs: [],
  lspLanguages: [],
  rtkChoiceRecorded: true,
});

const MARKERS = [KB_DIR, '.claude/agents', '.claude/skills', '.claude/workflow-config.json'];

/** The four files and directories an onboarding run leaves, except one. */
async function installMarkers(root: string, except?: string): Promise<void> {
  for (const rel of MARKERS) {
    if (rel === except) continue;
    if (rel.endsWith('.json')) {
      await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await writeFile(path.join(root, rel), '{}\n', 'utf8');
    } else {
      await mkdir(path.join(root, rel), { recursive: true });
    }
  }
}

const dirs: string[] = [];
async function newRoot(except?: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'upgrade-gate-'));
  dirs.push(root);
  await installMarkers(root, except);
  return root;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

interface TaskSeed {
  type?: 'onboarding' | 'onboarding_upgrade';
  status: string;
  completedAt?: number;
}

interface World {
  /** What the repository row holds. */
  column?: unknown;
  status?: string;
  root?: string | null;
  localRoot?: string | null;
  onboardedAt?: number | null;
  resetAt?: number | null;
  tasks?: TaskSeed[];
  /** Onboarding tasks of another repository of the same user. */
  otherTasks?: TaskSeed[];
  /** A live artifact row, which the existing gate admits on its own. `at` dates it and `source` names
   *  what wrote it. */
  artifact?: boolean | { at: number; source?: 'onboarding' | 'upgrade' };
}

/** One repository the way POST /tasks finds it, in a database that evaluates its filters. */
async function world(w: World = {}) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskEvents: schema.taskEvents,
    repositories: schema.repositories,
    onboardingArtifacts: schema.onboardingArtifacts,
  });
  const root = w.root === undefined ? await newRoot() : w.root;
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'repo',
    status: w.status ?? 'ready',
    storagePath: root,
    localPath: w.localRoot ?? null,
    renderContext: w.column === undefined ? portableOnly() : w.column,
    onboardedAt:
      w.onboardedAt === undefined || w.onboardedAt === null ? null : new Date(w.onboardedAt),
    onboardingResetAt: w.resetAt === undefined || w.resetAt === null ? null : new Date(w.resetAt),
  });
  const seeded = (w.tasks ?? []).map(
    (t) =>
      fake.insert(schema.tasks, {
        userId: USER,
        repositoryId: REPO,
        type: t.type ?? 'onboarding',
        title: t.type ?? 'onboarding',
        status: t.status,
        completedAt: t.completedAt === undefined ? null : new Date(t.completedAt),
      }).id as string,
  );
  for (const t of w.otherTasks ?? []) {
    fake.insert(schema.tasks, {
      userId: USER,
      repositoryId: '00000000-0000-4000-8000-0000000000c9',
      type: t.type ?? 'onboarding',
      title: 'onboarding',
      status: t.status,
      completedAt: t.completedAt === undefined ? null : new Date(t.completedAt),
    });
  }
  if (w.artifact) {
    fake.insert(schema.onboardingArtifacts, {
      userId: USER,
      repositoryId: REPO,
      taskId: seeded[0] ?? '00000000-0000-4000-8000-0000000000d1',
      diskPath: '.claude/agents/code-reviewer.md',
      templateId: 'agent.code-reviewer',
      templateKind: 'agent',
      templateSchemaVersion: 1,
      templateContentHash: 'h',
      writtenHash: 'w',
      sourceStepId: '12-post-onboarding',
      source: typeof w.artifact === 'object' ? (w.artifact.source ?? 'onboarding') : 'onboarding',
      generatedAt: new Date(typeof w.artifact === 'object' ? w.artifact.at : 0),
      supersededAt: null,
    });
  }
  h.db = fake.db;
  const upgrades = () =>
    fake
      .rows(schema.tasks)
      .filter((r) => r.type === 'onboarding_upgrade' && !seeded.includes(r.id as string));
  return { fake, upgrades, seeded };
}

// Decision 5a: the verdict's inputs sit together, and lib never imports a route.
describe('lib/onboarding-state', () => {
  it('A0: holds the four onboarding markers and the check of them, beside the verdict', () => {
    const lib = onboardingState as unknown as Record<string, unknown>;
    expect(lib.ONBOARDING_MARKERS).toEqual([
      '.haive-data/knowledge_base',
      '.claude/agents',
      '.claude/skills',
      '.claude/workflow-config.json',
    ]);
    expect(typeof lib.checkOnboardingMarkers).toBe('function');
  });
});

const refusal = async (res: Response) => ((await res.json()) as { error: string }).error;

describe('POST /tasks starts an upgrade on a repository only its render context vouches for', () => {
  // A1
  it('A1: admits a repository holding a portable-only column, its markers, and no history', async () => {
    const t = await world();
    const res = await startUpgrade();
    expect(res.status).toBe(201);
    expect(t.upgrades()).toHaveLength(1);
  });

  it('A1b: admits a clone whose onboarding wrote only codex agents and skills', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'upgrade-gate-codex-'));
    dirs.push(root);
    for (const dir of [KB_DIR, '.codex/agents', '.agents/skills', '.claude']) {
      await mkdir(path.join(root, dir), { recursive: true });
    }
    await writeFile(path.join(root, '.claude/workflow-config.json'), '{}\n', 'utf8');
    const t = await world({ root });

    const res = await startUpgrade();

    expect(res.status).toBe(201);
    expect(t.upgrades()).toHaveLength(1);
  });

  // A2
  it.each([...LIVE_TASK_STATUSES])(
    'A2: refuses beside an onboarding that is %s',
    async (status) => {
      const t = await world({ tasks: [{ status }] });
      const res = await startUpgrade();
      expect(res.status).toBe(409);
      expect(await refusal(res)).toContain(t.seeded[0]!);
      expect(t.upgrades()).toEqual([]);
    },
  );

  // A3, A4
  it.each([...MARKERS])('A3/A4: refuses with %s missing from the checkout', async (missing) => {
    const t = await world({ root: await newRoot(missing) });
    const res = await startUpgrade();
    expect(res.status).toBe(409);
    expect(await refusal(res)).toBe(NO_ONBOARDING);
    expect(t.upgrades()).toEqual([]);
  });

  // A5
  it.each([
    ['no onboarding since', []],
    ['an onboarding since that failed', [{ status: 'failed' }]],
    ['an onboarding since that was cancelled', [{ status: 'cancelled' }]],
  ])('A5: refuses after a reset, with %s', async (_name, tasks) => {
    const t = await world({ resetAt: 1000, tasks });
    const res = await startUpgrade();
    expect(res.status).toBe(409);
    expect(await refusal(res)).toMatch(/reset/);
    expect(t.upgrades()).toEqual([]);
  });

  it('A5b: refuses a repository whose only onboarding failed, or was cancelled, and was never reset', async () => {
    for (const status of ['failed', 'cancelled']) {
      const t = await world({ tasks: [{ status }] });
      const res = await startUpgrade();
      expect({ status, code: res.status }).toEqual({ status, code: 409 });
      expect(t.upgrades()).toEqual([]);
    }
  });

  // A6
  it.each(['error', 'cloning'])('A6: refuses a repository that is %s', async (status) => {
    const t = await world({ status });
    const res = await startUpgrade();
    expect(res.status).toBe(409);
    expect(await refusal(res)).toBe(NO_ONBOARDING);
    expect(t.upgrades()).toEqual([]);
  });

  // A7
  it.each([
    ['an empty object', {}],
    ['an unknown key beside a portable-only context', { ...portableOnly(), somethingNew: true }],
    ['a context without rtkChoiceRecorded', { ...portableOnly(), rtkChoiceRecorded: undefined }],
    ['a context missing a portable field', { ...portableOnly(), framework: undefined }],
    ['text', 'not a context'],
  ])('A7: refuses a column the schema refuses: %s', async (_name, column) => {
    const t = await world({ column });
    const res = await startUpgrade();
    expect(res.status).toBe(409);
    expect(await refusal(res)).toBe(NO_ONBOARDING);
    expect(t.upgrades()).toEqual([]);
  });

  it('A7b: refuses a NULL column, which is the repository main refused', async () => {
    const t = await world({ column: null });
    const res = await startUpgrade();
    expect(res.status).toBe(409);
    expect(await refusal(res)).toBe(NO_ONBOARDING);
    expect(t.upgrades()).toEqual([]);
  });

  // A8
  it('A8: admits a reset repository once it was stamped onboarded after the reset', async () => {
    const t = await world({ resetAt: 1000, onboardedAt: 2000 });
    const res = await startUpgrade();
    expect(res.status).toBe(201);
    expect(t.upgrades()).toHaveLength(1);
  });

  it('A8b: refuses a repository with neither a storage path nor a local path', async () => {
    const t = await world({ root: null });
    const res = await startUpgrade();
    expect(res.status).toBe(409);
    expect(t.upgrades()).toEqual([]);
  });

  it('A8c: reads the checkout of a repository that has a local path and no storage path', async () => {
    const local = await newRoot();
    const t = await world({ root: null, localRoot: local });
    const res = await startUpgrade();
    expect(res.status).toBe(201);
    expect(t.upgrades()).toHaveLength(1);
  });

  it("A11: reads this repository's onboarding history, not another repository's", async () => {
    const t = await world({
      otherTasks: [{ status: 'running' }, { status: 'completed', completedAt: 1 }],
    });
    const res = await startUpgrade();
    expect(res.status).toBe(201);
    expect(t.upgrades()).toHaveLength(1);
  });

  // A9
  it('A9: still refuses beside a live upgrade, naming it, when the existing terms admit', async () => {
    const t = await world({
      tasks: [
        { status: 'completed', completedAt: 1 },
        { type: 'onboarding_upgrade', status: 'waiting_user' },
      ],
    });
    const res = await startUpgrade();
    expect(res.status).toBe(409);
    expect(await refusal(res)).toContain(t.seeded[1]!);
  });

  it('A9b: and when only the render context admits', async () => {
    const t = await world({ tasks: [{ type: 'onboarding_upgrade', status: 'waiting_user' }] });
    const res = await startUpgrade();
    expect(res.status).toBe(409);
    expect(await refusal(res)).toContain(t.seeded[0]!);
  });
});

// The artifact term needs neither the column nor the markers; what it reads of a reset is below.
describe('POST /tasks keeps the terms it already had, whatever the column says', () => {
  it.each([
    ['NULL', null],
    ['refused', {}],
    ['a column it reads', undefined],
  ])(
    'P2: admits a live artifact row with a marker missing, with a %s column',
    async (_n, column) => {
      const t = await world({ column, artifact: true, root: await newRoot('.claude/skills') });
      const res = await startUpgrade();
      expect(res.status).toBe(201);
      expect(t.upgrades()).toHaveLength(1);
    },
  );

  it('P4: refuses a repository with no column, no onboarding and no row, with the text it always had', async () => {
    const t = await world({ column: null });
    const res = await startUpgrade();
    expect(res.status).toBe(409);
    expect(await refusal(res)).toBe(NO_ONBOARDING);
    expect(t.upgrades()).toEqual([]);
  });
});

// #165, #166: the gate's older terms (a completed onboarding, a live row) read neither the reset epoch
// nor a live onboarding, so a reset repository took an upgrade, and one could start beside a run.
describe('POST /tasks starts an upgrade only on a repository the onboarding verdict calls onboarded', () => {
  const RESET = 5000;

  it.each([
    ['NULL', null],
    ['refused', {}],
    ['readable', undefined],
  ])('refuses a completion from before the reset, with a %s column', async (_n, column) => {
    const t = await world({
      column,
      resetAt: RESET,
      tasks: [{ status: 'completed', completedAt: 1000 }],
    });
    const res = await startUpgrade();
    expect(res.status).toBe(409);
    expect(await refusal(res)).toMatch(/reset/);
    expect(t.upgrades()).toEqual([]);
  });

  it('admits a completion from after the reset', async () => {
    const t = await world({
      column: null,
      resetAt: RESET,
      tasks: [{ status: 'completed', completedAt: 6000 }],
    });
    const res = await startUpgrade();
    expect(res.status).toBe(201);
    expect(t.upgrades()).toHaveLength(1);
  });

  it.each([...LIVE_TASK_STATUSES])(
    'refuses beside an onboarding that is %s, though one completed before',
    async (status) => {
      const t = await world({
        column: null,
        tasks: [{ status: 'completed', completedAt: 1 }, { status }],
      });
      const res = await startUpgrade();
      expect(res.status).toBe(409);
      expect(await refusal(res)).toContain(t.seeded[1]!);
      expect(t.upgrades()).toEqual([]);
    },
  );

  it('refuses beside a running onboarding when a live artifact row would admit it', async () => {
    const t = await world({ column: null, artifact: true, tasks: [{ status: 'running' }] });
    const res = await startUpgrade();
    expect(res.status).toBe(409);
    expect(await refusal(res)).toContain(t.seeded[0]!);
    expect(t.upgrades()).toEqual([]);
  });

  it('admits an onboarding row written after the reset, with no completion', async () => {
    const t = await world({ column: null, resetAt: RESET, artifact: { at: 6000 } });
    const res = await startUpgrade();
    expect(res.status).toBe(201);
    expect(t.upgrades()).toHaveLength(1);
  });

  it('refuses the rows a partial reset kept, which were written before it', async () => {
    const t = await world({ column: null, resetAt: RESET, artifact: { at: 1000 } });
    const res = await startUpgrade();
    expect(res.status).toBe(409);
    expect(await refusal(res)).toMatch(/reset/);
    expect(t.upgrades()).toEqual([]);
  });

  it('does not take a row an upgrade wrote after the reset for an onboarding', async () => {
    const t = await world({
      column: null,
      resetAt: RESET,
      artifact: { at: 6000, source: 'upgrade' },
    });
    const res = await startUpgrade();
    expect(res.status).toBe(409);
    expect(await refusal(res)).toMatch(/reset/);
    expect(t.upgrades()).toEqual([]);
  });
});

type Admits = (db: unknown, userId: string, repo: Record<string, unknown>) => Promise<boolean>;
const admitsFn = (): Admits => {
  const fn = (onboardingState as unknown as Record<string, unknown>).renderContextAdmitsUpgrade;
  if (typeof fn !== 'function') {
    throw new Error('lib/onboarding-state does not export renderContextAdmitsUpgrade');
  }
  return fn as Admits;
};

interface Case extends World {
  name: string;
  admits: boolean;
  /** Missing marker, or none. */
  missing?: string;
}

// A10. The route and the banner both ask this one function, so what it answers is what both say.
describe('renderContextAdmitsUpgrade', () => {
  const NEVER_ONBOARDED: Case[] = [
    { name: 'a portable-only column, markers, ready, no history', admits: true },
    {
      name: 'a column a writer recorded in full',
      column: {
        ...portableOnly(),
        agentTargets: [{ dir: '.claude/agents', format: 'markdown' }],
        enabledCliProviders: [
          { name: 'claude-code', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' },
        ],
        rtkEnabled: false,
      },
      admits: true,
    },
    ...LIVE_TASK_STATUSES.map((status) => ({
      name: `an onboarding that is ${status}`,
      tasks: [{ status }],
      admits: false,
    })),
    ...MARKERS.map((marker) => ({
      name: `${marker} missing`,
      missing: marker,
      admits: false,
    })),
    { name: 'a reset with no onboarding since', resetAt: 1000, admits: false },
    {
      name: 'a reset and a failed onboarding since',
      resetAt: 1000,
      tasks: [{ status: 'failed' }],
      admits: false,
    },
    { name: 'a failed onboarding, never reset', tasks: [{ status: 'failed' }], admits: false },
    {
      name: 'a cancelled onboarding, never reset',
      tasks: [{ status: 'cancelled' }],
      admits: false,
    },
    { name: 'a reset, then onboarded_at', resetAt: 1000, onboardedAt: 2000, admits: true },
    { name: 'status error', status: 'error', admits: false },
    { name: 'status cloning', status: 'cloning', admits: false },
    { name: 'an empty column', column: {}, admits: false },
    { name: 'a column with an unknown key', column: { ...portableOnly(), x: 1 }, admits: false },
    { name: 'a NULL column', column: null, admits: false },
    { name: 'no root at all', root: null, admits: false },
  ];

  it.each(NEVER_ONBOARDED)('A10: answers $admits for $name, as POST /tasks does', async (c) => {
    const root = c.root === null ? null : await newRoot(c.missing);
    const t = await world({ ...c, root });
    const repoRow = t.fake.rows(schema.repositories)[0]!;
    expect(await admitsFn()(t.fake.db, USER, repoRow)).toBe(c.admits);
    const res = await startUpgrade();
    expect(res.status).toBe(c.admits ? 201 : 409);
  });

  // With a completed onboarding the route's own term admits first, so only the function is asked.
  const COMPLETED: Case[] = [
    {
      name: 'a completion after the reset',
      resetAt: 1000,
      tasks: [{ status: 'completed', completedAt: 2000 }],
      admits: true,
    },
    {
      name: 'a completion before the reset, and no stamp',
      resetAt: 3000,
      tasks: [{ status: 'completed', completedAt: 2000 }],
      admits: false,
    },
    {
      name: 'a completion before the reset, and a stamp after it',
      resetAt: 3000,
      onboardedAt: 4000,
      tasks: [{ status: 'completed', completedAt: 2000 }],
      admits: true,
    },
    {
      name: 'a completion, never reset',
      tasks: [{ status: 'completed', completedAt: 1 }],
      admits: true,
    },
    {
      name: 'a completion and a live onboarding',
      tasks: [{ status: 'completed', completedAt: 1 }, { status: 'running' }],
      admits: false,
    },
  ];

  it.each(COMPLETED)('A10b: answers $admits for $name', async (c) => {
    const t = await world({ ...c });
    const repoRow = t.fake.rows(schema.repositories)[0]!;
    expect(await admitsFn()(t.fake.db, USER, repoRow)).toBe(c.admits);
  });

  it('A10c: needs no column of the repository row beyond the seven it names', async () => {
    const t = await world();
    const row = t.fake.rows(schema.repositories)[0]!;
    const needed = {
      id: row.id,
      renderContext: row.renderContext,
      status: row.status,
      storagePath: row.storagePath,
      localPath: row.localPath,
      onboardedAt: row.onboardedAt,
      onboardingResetAt: row.onboardingResetAt,
    };
    expect(await admitsFn()(t.fake.db, USER, needed)).toBe(true);
  });
});
