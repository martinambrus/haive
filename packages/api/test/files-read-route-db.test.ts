import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import type { AppEnv } from '@haive/shared/module-host';
import type {
  FilesReadBucket,
  FilesReadCoverage,
  FilesReadFileRow,
  FilesReadReport,
  FilesReadStepRow,
} from '@haive/shared/stats';
import createStatsRoutes from '@haive/module-statistics/routes';
import { errorHandler } from '../src/middleware/error-handler.js';

const url = process.env.FILES_READ_TEST_URL;
if (url && new URL(url).pathname !== '/files_read_test')
  throw new Error('Use a dedicated files_read_test database');

// Every expectation below is hand-computed from the population rules (see the comments), never
// read back from the implementation. recorded = a `reads` object exists; observable = coverage
// full or partial; weighted = observable with a known `fileReads.weightedChars`; a step share
// run = weighted AND resultSeen AND token usage with a positive prompt side.

const FROM = new Date('2026-11-01T00:00:00Z');
const TO = new Date('2026-11-15T00:00:00Z');
const AT = new Date('2026-11-05T10:00:00Z');
const DAY = 86_400_000;

type Body = { available: boolean; range?: unknown; scope?: unknown } & FilesReadReport;
type Tuple3 = [reads: number, chars: number, weighted: number];
type FileTuple = [path: string, reads: number, chars: number, weighted: number];

interface ReadsSpec {
  coverage?: 'full' | 'partial' | 'none';
  resultSeen: boolean;
  /** false: every weightedChars is JSON null (turns unknown or elided); tuple weights are ignored. */
  weighted: boolean;
  files: FileTuple[];
  overflow?: [...Tuple3, omitted: number];
  multi?: Tuple3;
}

function reads(spec: ReadsSpec) {
  const w = (n: number): number | null => (spec.weighted ? n : null);
  const count = (r: number, c: number, wc: number) => ({
    reads: r,
    chars: c,
    weightedChars: w(wc),
  });
  const ov = spec.overflow ?? [0, 0, 0, 0];
  const mf = spec.multi ?? [0, 0, 0];
  const sum = (pick: (f: FileTuple) => number) => spec.files.reduce((a, f) => a + pick(f), 0);
  const fileReads = count(
    sum((f) => f[1]) + ov[0] + mf[0],
    sum((f) => f[2]) + ov[1] + mf[1],
    sum((f) => f[3]) + ov[2] + mf[2],
  );
  return {
    version: 1,
    coverage: spec.coverage ?? 'full',
    turns: spec.weighted ? 12 : null,
    compactions: 0,
    resultSeen: spec.resultSeen,
    results: fileReads,
    fileReads,
    files: spec.files.map(([path, r, c, wc]) => ({ path, ...count(r, c, wc) })),
    outside: count(0, 0, 0),
    multiFile: count(...mf),
    unattributed: count(0, 0, 0),
    overflow: { ...count(ov[0], ov[1], ov[2]), omitted: ov[3] },
    byTool: {},
  };
}

const tok = (input: number, output: number, cacheRead = 0, cacheCreation = 0) => ({
  inputTokens: input,
  outputTokens: output,
  totalTokens: input + output + cacheRead + cacheCreation,
  cacheReadTokens: cacheRead,
  cacheCreationTokens: cacheCreation,
});

const fillerPath = (i: number) => `fill/p${String(i).padStart(2, '0')}.ts`;
// Filler i (1..42): one read, chars 10 + i, weighted 3 * chars + 1 = 31 + 3i.
const fillers: FileTuple[] = Array.from({ length: 42 }, (_, k) => {
  const i = k + 1;
  return [fillerPath(i), 1, 10 + i, 31 + 3 * i];
});

const near = (actual: unknown, expected: number) => {
  expect(typeof actual).toBe('number');
  expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(
    Math.abs(expected) * 1e-9 + 1e-12,
  );
};

function expectShare(
  share: { ratio: number | null; n: number; sufficient: boolean },
  ratio: number | null,
  n: number,
) {
  if (ratio === null) expect(share.ratio).toBeNull();
  else near(share.ratio, ratio);
  expect(share.n).toBe(n);
  expect(share.sufficient).toBe(n >= 5);
}

interface RowExpect {
  path: string;
  reads: number;
  chars: number;
  w: number | null;
  wRuns: number;
  runs: number;
  tasks: number;
}

/** T = the scope's summed weighted characters, W = its weighted run count. */
function expectRow(row: FilesReadFileRow, e: RowExpect, T: number, W: number) {
  expect(row).toMatchObject({
    path: e.path,
    reads: e.reads,
    chars: e.chars,
    weightedChars: e.w,
    weightedRuns: e.wRuns,
    runs: e.runs,
    tasks: e.tasks,
  });
  if (e.w === null) expect(row.estimatedTokens).toBeNull();
  else near(row.estimatedTokens, e.w / 4);
  expectShare(row.share, e.w !== null && T > 0 ? e.w / T : null, W);
}

/** `part`: weighted characters of the bucket, null when no run's weight is known. */
function expectBucket(
  b: FilesReadBucket,
  reads: number,
  chars: number,
  part: number | null,
  T: number,
  W: number,
) {
  expect(b.reads).toBe(reads);
  expect(b.chars).toBe(chars);
  if (part === null) expect(b.estimatedTokens).toBeNull();
  else near(b.estimatedTokens, part / 4);
  expectShare(b.share, part !== null && T > 0 ? part / T : null, W);
}

function expectStep(
  row: FilesReadStepRow,
  e: {
    stepId: string;
    runs: number;
    est: number | null;
    prompt: number | null;
    n: number;
    ratio: number | null;
    exceeds: boolean;
  },
) {
  expect(row).toMatchObject({ stepId: e.stepId, runs: e.runs, exceedsPrompt: e.exceeds });
  if (e.est === null) expect(row.estimatedTokens).toBeNull();
  else near(row.estimatedTokens, e.est);
  if (e.prompt === null) expect(row.promptTokens).toBeNull();
  else near(row.promptTokens, e.prompt);
  expect(row.share.n).toBe(e.n);
  expect(row.share.sufficient).toBe(e.n >= 5);
  if (e.ratio === null) expect(row.share.ratio).toBeNull();
  else near(row.share.ratio, e.ratio);
}

function expectCoverage(c: FilesReadCoverage, e: FilesReadCoverage) {
  expect(c).toMatchObject(e);
  expect(c.total).toBe(c.recorded + c.unrecorded + c.inFlight);
  expect(c.recorded).toBe(c.observable + c.unobservable);
}

describe.skipIf(!url)('GET /m/statistics/files-read on migrated PostgreSQL', () => {
  let db: Database;
  let end: () => Promise<void>;
  const u1 = randomUUID();
  const u2 = randomUUID();
  const adminId = randomUUID();
  const r1 = randomUUID();
  const r2 = randomUUID();
  const r3 = randomUUID();
  const r4 = randomUUID();
  const providers = {
    cc: randomUUID(),
    cx: randomUUID(),
    gm: randomUUID(),
    u2: randomUUID(),
  };
  const taskIds = {
    t1: randomUUID(),
    t2: randomUUID(),
    t3: randomUUID(),
    t4: randomUUID(),
    t5: randomUUID(),
    t6: randomUUID(),
  };
  const stepIds = new Map<string, string>();
  let mainRequest: Promise<Body> | undefined;

  const stepKey = (task: keyof typeof taskIds, step: string) => `${task}:${step}`;

  interface Run {
    task: keyof typeof taskIds;
    step?: string;
    summaryFor?: string;
    provider: keyof typeof providers | null;
    startedAt?: Date;
    ended?: boolean;
    toolUsage: unknown;
    tokenUsage?: ReturnType<typeof tok> | null;
    superseded?: boolean;
  }

  async function seed() {
    const user = (id: string, tag: string) => ({
      id,
      emailEncrypted: tag,
      emailBlindIndex: `${tag}-${randomBytes(6).toString('hex')}`,
      passwordHash: 'not-real',
      role: 'user' as const,
      status: 'active' as const,
      tokenVersion: 0,
    });
    await db.insert(schema.users).values([user(u1, 'files-read-u1'), user(u2, 'files-read-u2')]);
    await db.insert(schema.repositories).values(
      [r1, r2, r3, r4].map((id) => ({
        id,
        userId: u1,
        name: `files-read-${id}`,
        source: 'blank' as const,
      })),
    );
    const provider = (id: string, userId: string, name: 'claude-code' | 'codex' | 'gemini') => ({
      id,
      userId,
      name,
      label: `files-read-${name}`,
      authMode: 'api_key' as const,
    });
    await db
      .insert(schema.cliProviders)
      .values([
        provider(providers.cc, u1, 'claude-code'),
        provider(providers.cx, u1, 'codex'),
        provider(providers.gm, u1, 'gemini'),
        provider(providers.u2, u2, 'claude-code'),
      ]);

    const taskDefs: Array<[keyof typeof taskIds, string, string, string[]]> = [
      ['t1', u1, r1, ['02-fill', '03-plan', '04-implement']],
      ['t2', u1, r1, ['03-plan', '04-implement', '05-review']],
      ['t3', u1, r3, ['03-plan']],
      ['t4', u1, r4, ['06-huge']],
      ['t5', u1, r2, ['04-implement']],
      ['t6', u2, r1, ['04-implement']],
    ];
    await db.insert(schema.tasks).values(
      taskDefs.map(([key, userId, repositoryId]) => ({
        id: taskIds[key],
        userId,
        repositoryId,
        type: 'workflow',
        title: `files-read ${key}`,
      })),
    );
    const steps = taskDefs.flatMap(([key, , , ids]) =>
      ids.map((stepId, index) => {
        const id = randomUUID();
        stepIds.set(stepKey(key, stepId), id);
        return { id, taskId: taskIds[key], stepId, stepIndex: index + 1, title: stepId };
      }),
    );
    await db.insert(schema.taskSteps).values(steps);

    const stepFor = (task: keyof typeof taskIds, step: string) => stepIds.get(stepKey(task, step))!;
    const runs: Run[] = [
      // r1: weighted share run, claude-code. prompt side = 20000 + 30000 + 4000 = 54000.
      {
        task: 't1',
        step: '04-implement',
        provider: 'cc',
        tokenUsage: tok(20000, 100, 30000, 4000),
        toolUsage: {
          reads: reads({
            resultSeen: true,
            weighted: true,
            files: [
              ['a.ts', 2, 4000, 40000],
              ['b.ts', 1, 2000, 8000],
            ],
            multi: [3, 1200, 4800],
            overflow: [4, 800, 1600, 4],
          }),
        },
      },
      // r2: weighted share run, codex: input INCLUDES cache reads, fresh 400, prompt 400 + 600 + 50 = 1050.
      {
        task: 't2',
        step: '04-implement',
        provider: 'cx',
        tokenUsage: tok(1000, 50, 600, 50),
        toolUsage: {
          reads: reads({
            resultSeen: true,
            weighted: true,
            files: [
              ['a.ts', 1, 100, 400],
              ['c.ts', 2, 300, 800],
            ],
          }),
        },
      },
      // r3: weighted share run in another step: est 2400 / 4 = 600 against prompt 100 + 200 = 300.
      {
        task: 't2',
        step: '05-review',
        provider: 'cc',
        tokenUsage: tok(100, 20, 200, 0),
        toolUsage: {
          reads: reads({
            resultSeen: true,
            weighted: true,
            files: [
              ['b.ts', 1, 500, 2000],
              ['d.ts', 1, 100, 400],
            ],
          }),
        },
      },
      // r4: weighted, result event never seen: in file totals, not a share run. Starts at `from`.
      {
        task: 't1',
        step: '04-implement',
        provider: 'cc',
        startedAt: FROM,
        tokenUsage: tok(7777, 10),
        toolUsage: {
          reads: reads({ resultSeen: false, weighted: true, files: [['e.ts', 1, 400, 1600]] }),
        },
      },
      // r5: weighted, no token usage at all.
      {
        task: 't2',
        step: '04-implement',
        provider: 'cc',
        tokenUsage: null,
        toolUsage: {
          reads: reads({ resultSeen: true, weighted: true, files: [['f.ts', 1, 200, 800]] }),
        },
      },
      // r5b: weighted, result seen, token usage with a prompt side of 0.
      {
        task: 't2',
        step: '04-implement',
        provider: 'cc',
        tokenUsage: tok(0, 5),
        toolUsage: {
          reads: reads({ resultSeen: true, weighted: true, files: [['g.ts', 1, 40, 160]] }),
        },
      },
      // r6: full coverage, every weight null: counted as exact reads, never a weight.
      {
        task: 't1',
        step: '03-plan',
        provider: 'cc',
        tokenUsage: tok(5555, 10),
        toolUsage: {
          reads: reads({
            resultSeen: true,
            weighted: false,
            files: [['h.ts', 3, 900, 0]],
            multi: [1, 100, 0],
          }),
        },
      },
      // r7: partial (elided transcript), null weights, plus six null-weight filler paths.
      {
        task: 't2',
        step: '03-plan',
        provider: 'cc',
        tokenUsage: tok(6666, 10),
        toolUsage: {
          reads: reads({
            coverage: 'partial',
            resultSeen: true,
            weighted: false,
            files: [
              ['h.ts', 1, 300, 0],
              ['i.ts', 2, 500, 0],
              ...[1, 2, 3, 4, 5, 6].map((n): FileTuple => [`null/n${n}.ts`, 1, 10, 0]),
            ],
          }),
        },
      },
      // r8: coverage none. ghost.ts must not count: coverage none is not observable.
      {
        task: 't2',
        step: '03-plan',
        provider: 'cx',
        toolUsage: {
          reads: reads({
            coverage: 'none',
            resultSeen: true,
            weighted: false,
            files: [['ghost.ts', 5, 5000, 20000]],
          }),
        },
      },
      // r9 / r10 / r11: ended with no usable record. r12: the same, still running.
      { task: 't2', step: '03-plan', provider: 'cc', toolUsage: { nativeTools: [] } },
      { task: 't2', step: '03-plan', provider: 'cx', toolUsage: { reads: null } },
      { task: 't2', summaryFor: '05-review', provider: 'cc', toolUsage: null },
      { task: 't1', step: '03-plan', provider: 'cc', ended: false, toolUsage: null },
      // r13: provider deleted below: in coverage as provider null, never in a step share.
      {
        task: 't1',
        step: '04-implement',
        provider: 'gm',
        tokenUsage: tok(3333, 10),
        toolUsage: {
          reads: reads({ resultSeen: true, weighted: true, files: [['j.ts', 1, 1000, 4000]] }),
        },
      },
      // rf: 42 fillers plus the C-collation tie pair, weighted, result never seen.
      {
        task: 't1',
        step: '02-fill',
        provider: 'cc',
        tokenUsage: tok(4444, 10),
        toolUsage: {
          reads: reads({
            resultSeen: false,
            weighted: true,
            files: [...fillers, ['dir/B.ts', 1, 250, 1000], ['dir/a.ts', 1, 250, 1000]],
          }),
        },
      },
      // x1 (another user's task in R1, visible only to an admin asking for all users).
      {
        task: 't6',
        step: '04-implement',
        provider: 'u2',
        tokenUsage: tok(1000, 10),
        toolUsage: {
          reads: reads({ resultSeen: true, weighted: true, files: [['u2-only.ts', 1, 800, 3200]] }),
        },
      },
      // x2 (R2), x3 (superseded), x4 (before `from`), x5 (no step), x6 (starts exactly at `to`).
      {
        task: 't5',
        step: '04-implement',
        provider: 'cc',
        tokenUsage: tok(777777, 10),
        toolUsage: {
          reads: reads({ resultSeen: true, weighted: true, files: [['r2-only.ts', 1, 900, 5000]] }),
        },
      },
      {
        task: 't1',
        step: '04-implement',
        provider: 'cc',
        superseded: true,
        tokenUsage: tok(222222, 10),
        toolUsage: {
          reads: reads({
            resultSeen: true,
            weighted: true,
            files: [['superseded.ts', 1, 900, 6000]],
          }),
        },
      },
      {
        task: 't1',
        step: '04-implement',
        provider: 'cc',
        startedAt: new Date('2026-10-20T10:00:00Z'),
        tokenUsage: tok(333333, 10),
        toolUsage: {
          reads: reads({
            resultSeen: true,
            weighted: true,
            files: [['before-window.ts', 1, 900, 7000]],
          }),
        },
      },
      {
        task: 't1',
        provider: 'cc',
        tokenUsage: tok(444444, 10),
        toolUsage: {
          reads: reads({
            resultSeen: true,
            weighted: true,
            files: [['unattributed.ts', 1, 900, 7500]],
          }),
        },
      },
      {
        task: 't1',
        step: '04-implement',
        provider: 'cc',
        startedAt: TO,
        tokenUsage: tok(555555, 10),
        toolUsage: {
          reads: reads({ resultSeen: true, weighted: true, files: [['at-to.ts', 1, 900, 8000]] }),
        },
      },
      // R3: every weight unknown. rA full (with overflow and multi), rB partial, rC unrecorded.
      {
        task: 't3',
        step: '03-plan',
        provider: 'cc',
        tokenUsage: tok(100, 10),
        toolUsage: {
          reads: reads({
            resultSeen: true,
            weighted: false,
            files: [['x.ts', 2, 600, 0]],
            multi: [1, 100, 0],
            overflow: [3, 300, 0, 3],
          }),
        },
      },
      {
        task: 't3',
        step: '03-plan',
        provider: 'cc',
        tokenUsage: tok(100, 10),
        toolUsage: {
          reads: reads({
            coverage: 'partial',
            resultSeen: true,
            weighted: false,
            files: [
              ['x.ts', 1, 50, 0],
              ['y.ts', 1, 200, 0],
            ],
          }),
        },
      },
      { task: 't3', summaryFor: '03-plan', provider: 'cc', toolUsage: null },
      // R4: numbers above 2^31 (sums must not be cast to int).
      {
        task: 't4',
        step: '06-huge',
        provider: 'cc',
        tokenUsage: tok(3_000_000_000, 10, 1_000_000_000, 0),
        toolUsage: {
          reads: reads({
            resultSeen: true,
            weighted: true,
            files: [['huge.ts', 2_500_000_000, 5_000_000_000, 9_000_000_000]],
          }),
        },
      },
    ];
    await db.insert(schema.cliInvocations).values(
      runs.map((r) => {
        const startedAt = r.startedAt ?? AT;
        return {
          id: randomUUID(),
          taskId: taskIds[r.task],
          taskStepId: r.step ? stepFor(r.task, r.step) : null,
          summaryForStepId: r.summaryFor ? stepFor(r.task, r.summaryFor) : null,
          cliProviderId: r.provider ? providers[r.provider] : null,
          mode: 'cli' as const,
          prompt: 'files-read test',
          startedAt,
          endedAt: r.ended === false ? null : new Date(startedAt.getTime() + 60_000),
          supersededAt: r.superseded ? new Date('2026-11-06T00:00:00Z') : null,
          tokenUsage: r.tokenUsage ?? null,
          toolUsage: r.toolUsage as never,
        };
      }),
    );
    // r13 ran on a provider that was later deleted: its invocation keeps a null provider.
    await db.delete(schema.cliProviders).where(eq(schema.cliProviders.id, providers.gm));
  }

  function appFor(userId: string, role: 'user' | 'admin') {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('userId', userId);
      c.set('userRole', role);
      await next();
    });
    app.onError(errorHandler);
    app.route('/m/statistics', createStatsRoutes({ db }));
    return app;
  }

  async function get(
    params: Record<string, string>,
    who: { userId?: string; role?: 'user' | 'admin' } = {},
  ) {
    const query = new URLSearchParams({
      from: FROM.toISOString(),
      to: TO.toISOString(),
      tz: 'UTC',
      ...params,
    });
    const res = await appFor(who.userId ?? u1, who.role ?? 'user').request(
      `/m/statistics/files-read?${query.toString()}`,
    );
    const text = await res.text();
    let body = {} as Body;
    try {
      body = JSON.parse(text) as Body;
    } catch {
      // A missing route answers with plain text; the status assertion reports it.
    }
    return { status: res.status, body, text };
  }

  async function ok(
    params: Record<string, string>,
    who?: { userId?: string; role?: 'user' | 'admin' },
  ) {
    const res = await get(params, who);
    expect(res.status, res.text).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.range).toBeDefined();
    expect(res.body.scope).toBeDefined();
    return res.body;
  }

  beforeAll(async () => {
    db = createDatabase(url!);
    end = () =>
      (db as unknown as { $client: { end(o: object): Promise<void> } }).$client.end({ timeout: 5 });
    await seed();
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await db.delete(schema.users).where(eq(schema.users.id, u1));
    await db.delete(schema.users).where(eq(schema.users.id, u2));
    await end();
  });

  // R1, caller U1, no facet. 15 runs; T = 70571 weighted characters over W = 8 weighted runs.
  const T = 54400 + 1200 + 2400 + 1600 + 800 + 160 + 4000 + 6011;
  const W = 8;
  const getMain = () => (mainRequest ??= ok({ repositoryId: r1 }));

  it('counts coverage over the owner scope, with the deleted provider as null', async () => {
    const main = await getMain();
    expect(T).toBe(70571);
    expectCoverage(main.coverage, {
      total: 15,
      recorded: 11,
      observable: 10,
      partial: 1,
      unobservable: 1,
      unrecorded: 3,
      inFlight: 1,
      weighted: 8,
    });
    expect(main.coverage.byProvider).toHaveLength(3);
    const [cc, cx, none] = main.coverage.byProvider;
    expect(cc).toMatchObject({ provider: 'claude-code' });
    expectCoverage(cc!, {
      total: 11,
      recorded: 8,
      observable: 8,
      partial: 1,
      unobservable: 0,
      unrecorded: 2,
      inFlight: 1,
      weighted: 6,
    });
    expect(cx).toMatchObject({ provider: 'codex' });
    expectCoverage(cx!, {
      total: 3,
      recorded: 2,
      observable: 1,
      partial: 0,
      unobservable: 1,
      unrecorded: 1,
      inFlight: 0,
      weighted: 1,
    });
    expect(none!.provider).toBeNull();
    expectCoverage(none!, {
      total: 1,
      recorded: 1,
      observable: 1,
      partial: 0,
      unobservable: 0,
      unrecorded: 0,
      inFlight: 0,
      weighted: 1,
    });
  });

  it('totals the exact reads and characters and the estimate over weighted runs only', async () => {
    const main = await getMain();
    expect(main.totals.fileReads).toBe(10 + 3 + 2 + 1 + 1 + 1 + 4 + 9 + 1 + 44);
    expect(main.totals.fileReads).toBe(76);
    expect(main.totals.fileChars).toBe(14323);
    near(main.totals.estimatedTokens, 70571 / 4);
  });

  it('ranks the top 50 paths with every field, ties by characters then code point', async () => {
    const main = await getMain();
    const named: RowExpect[] = [
      { path: 'a.ts', reads: 3, chars: 4100, w: 40400, wRuns: 2, runs: 2, tasks: 2 },
      { path: 'b.ts', reads: 2, chars: 2500, w: 10000, wRuns: 2, runs: 2, tasks: 2 },
      { path: 'j.ts', reads: 1, chars: 1000, w: 4000, wRuns: 1, runs: 1, tasks: 1 },
      { path: 'e.ts', reads: 1, chars: 400, w: 1600, wRuns: 1, runs: 1, tasks: 1 },
      { path: 'dir/B.ts', reads: 1, chars: 250, w: 1000, wRuns: 1, runs: 1, tasks: 1 },
      { path: 'dir/a.ts', reads: 1, chars: 250, w: 1000, wRuns: 1, runs: 1, tasks: 1 },
      { path: 'c.ts', reads: 2, chars: 300, w: 800, wRuns: 1, runs: 1, tasks: 1 },
      { path: 'f.ts', reads: 1, chars: 200, w: 800, wRuns: 1, runs: 1, tasks: 1 },
      { path: 'd.ts', reads: 1, chars: 100, w: 400, wRuns: 1, runs: 1, tasks: 1 },
      { path: 'g.ts', reads: 1, chars: 40, w: 160, wRuns: 1, runs: 1, tasks: 1 },
    ];
    // Fillers p42 .. p03 follow: weight 31 + 3i falls from 157 to 40, below g.ts at 160.
    const filler: RowExpect[] = [];
    for (let i = 42; i >= 3; i--) {
      filler.push({
        path: fillerPath(i),
        reads: 1,
        chars: 10 + i,
        w: 31 + 3 * i,
        wRuns: 1,
        runs: 1,
        tasks: 1,
      });
    }
    const expected = [...named, ...filler];
    expect(expected).toHaveLength(50);
    expect(main.files.rows).toHaveLength(50);
    expect(main.files.count).toBe(60);
    expect(main.files.truncated).toBe(true);
    expected.forEach((e, k) => expectRow(main.files.rows[k]!, e, T, W));
  });

  it('keeps every figure of an excluded run out of the report', async () => {
    const main = await getMain();
    const paths = main.files.rows.map((r) => r.path);
    for (const gone of [
      'u2-only.ts',
      'r2-only.ts',
      'superseded.ts',
      'before-window.ts',
      'unattributed.ts',
      'at-to.ts',
      'ghost.ts',
      'huge.ts',
      'x.ts',
    ]) {
      expect(paths).not.toContain(gone);
    }
    // r4 starts exactly at `from` and is inside [from, to).
    expect(paths).toContain('e.ts');
  });

  it('reports the overflow, multi-file and remainder buckets and partitions the totals', async () => {
    const main = await getMain();
    expectBucket(main.overflow, 4, 800, 1600, T, W);
    expect(main.overflow).toMatchObject({ omitted: 4, runs: 1 });
    // multiFile: r1 3/1200/4800 and r6 1/100/null; the weight sums the weighted run only.
    expectBucket(main.multiFile, 4, 1300, 4800, T, W);
    expect(main.multiFile.runs).toBe(2);
    // otherPaths: p02 p01 and the 8 null-weight paths. reads 2 + 4 + 2 + 6, chars 23 + 1200 + 500 + 60.
    expect(main.otherPaths.paths).toBe(10);
    expectBucket(main.otherPaths, 14, 1783, 37 + 34, T, W);

    const rows = main.files.rows;
    const sum = (pick: (r: FilesReadFileRow) => number) => rows.reduce((a, r) => a + pick(r), 0);
    const buckets = [main.otherPaths, main.overflow, main.multiFile];
    expect(sum((r) => r.reads) + buckets.reduce((a, b) => a + b.reads, 0)).toBe(
      main.totals.fileReads,
    );
    expect(sum((r) => r.chars) + buckets.reduce((a, b) => a + b.chars, 0)).toBe(
      main.totals.fileChars,
    );
    expect(sum((r) => r.weightedChars ?? 0) + 71 + 1600 + 4800).toBe(T);
  });

  it('computes step shares over share runs only, normalising codex input', async () => {
    const main = await getMain();
    expect(main.steps.count).toBe(4);
    expect(main.steps.truncated).toBe(false);
    expect(main.steps.rows).toHaveLength(4);
    // 04-implement share runs: r1 and r2. r4 never saw its result, r5 has no tokens, r5b has a
    // zero prompt side, r13 has no provider. est (54400 + 1200) / 4; prompt 54000 + (400 + 600 + 50).
    expectStep(main.steps.rows[0]!, {
      stepId: '04-implement',
      runs: 6,
      est: 13900,
      prompt: 55050,
      n: 2,
      ratio: 13900 / 55050,
      exceeds: false,
    });
    // 05-review: est 2400 / 4 = 600 against prompt 300: a ratio of 2, shown and flagged, not clamped.
    expectStep(main.steps.rows[1]!, {
      stepId: '05-review',
      runs: 2,
      est: 600,
      prompt: 300,
      n: 1,
      ratio: 2,
      exceeds: true,
    });
    // 03-plan and 02-fill have no share run (unweighted, or result never seen): unknown, not 0.
    expectStep(main.steps.rows[2]!, {
      stepId: '03-plan',
      runs: 6,
      est: null,
      prompt: null,
      n: 0,
      ratio: null,
      exceeds: false,
    });
    expectStep(main.steps.rows[3]!, {
      stepId: '02-fill',
      runs: 1,
      est: null,
      prompt: null,
      n: 0,
      ratio: null,
      exceeds: false,
    });
  });

  it('shows an admin asking for all users the other users runs too', async () => {
    const body = await ok({ repositoryId: r1, allUsers: '1' }, { userId: adminId, role: 'admin' });
    // x1 adds 1 run, 1 read, 800 chars, 3200 weighted characters, and claude-code tokens 1000.
    expectCoverage(body.coverage, {
      total: 16,
      recorded: 12,
      observable: 11,
      partial: 1,
      unobservable: 1,
      unrecorded: 3,
      inFlight: 1,
      weighted: 9,
    });
    expect(body.coverage.byProvider[0]).toMatchObject({ provider: 'claude-code', total: 12 });
    expectCoverage(body.coverage.byProvider[0]!, {
      total: 12,
      recorded: 9,
      observable: 9,
      partial: 1,
      unobservable: 0,
      unrecorded: 2,
      inFlight: 1,
      weighted: 7,
    });
    expect(body.totals.fileReads).toBe(77);
    expect(body.totals.fileChars).toBe(15123);
    near(body.totals.estimatedTokens, 73771 / 4);
    expect(body.files.count).toBe(61);
    expectRow(
      body.files.rows[3]!,
      { path: 'u2-only.ts', reads: 1, chars: 800, w: 3200, wRuns: 1, runs: 1, tasks: 1 },
      73771,
      9,
    );
    expect(body.files.rows.map((r) => r.path).slice(0, 3)).toEqual(['a.ts', 'b.ts', 'j.ts']);
    expect(body.otherPaths.paths).toBe(11);
    expectStep(body.steps.rows[0]!, {
      stepId: '04-implement',
      runs: 7,
      est: 13900 + 800,
      prompt: 55050 + 1000,
      n: 3,
      ratio: 14700 / 56050,
      exceeds: false,
    });
  });

  it('refuses install-wide figures to a user and never leaks the other user without them', async () => {
    const res = await get({ repositoryId: r1, allUsers: '1' });
    expect(res.status, res.text).toBe(403);
    const main = await getMain();
    expect(main.files.rows.map((r) => r.path)).not.toContain('u2-only.ts');
    expect(main.coverage.total).toBe(15);
  });

  it('scopes to the repository facet and ignores a run of the same user in another repository', async () => {
    const main = await getMain();
    const other = await ok({ repositoryId: r2 });
    expect(other.coverage).toMatchObject({ total: 1, recorded: 1, observable: 1, weighted: 1 });
    expect(other.files.rows.map((r) => r.path)).toEqual(['r2-only.ts']);
    expect(other.totals).toMatchObject({ fileReads: 1, fileChars: 900 });
    near(other.totals.estimatedTokens, 5000 / 4);
    expect(main.coverage.total).toBe(15);
  });

  it('applies the window as [from, to)', async () => {
    // Narrow window: only r4 (at 2026-11-01) falls out.
    const narrow = await ok({
      repositoryId: r1,
      from: '2026-11-05T00:00:00Z',
      to: '2026-11-06T00:00:00Z',
    });
    expectCoverage(narrow.coverage, {
      total: 14,
      recorded: 10,
      observable: 9,
      partial: 1,
      unobservable: 1,
      unrecorded: 3,
      inFlight: 1,
      weighted: 7,
    });
    expect(narrow.totals.fileReads).toBe(75);
    expect(narrow.totals.fileChars).toBe(13923);
    near(narrow.totals.estimatedTokens, 68971 / 4);
    expect(narrow.files.count).toBe(59);
    expect(narrow.files.rows).toHaveLength(50);
    expect(narrow.files.rows.map((r) => r.path)).not.toContain('e.ts');
    expect(narrow.otherPaths.paths).toBe(9);
    expectStep(narrow.steps.rows[0]!, {
      stepId: '04-implement',
      runs: 5,
      est: 13900,
      prompt: 55050,
      n: 2,
      ratio: 13900 / 55050,
      exceeds: false,
    });
  });

  it('applies the provider facet and counts a run that ended with no record', async () => {
    const body = await ok({ repositoryId: r1, cliProviderId: providers.cx });
    expectCoverage(body.coverage, {
      total: 3,
      recorded: 2,
      observable: 1,
      partial: 0,
      unobservable: 1,
      unrecorded: 1,
      inFlight: 0,
      weighted: 1,
    });
    expect(body.coverage.byProvider).toHaveLength(1);
    expect(body.coverage.byProvider[0]).toMatchObject({ provider: 'codex', total: 3 });
    expect(body.totals).toMatchObject({ fileReads: 3, fileChars: 400 });
    near(body.totals.estimatedTokens, 300);
    expect(body.files.count).toBe(2);
    expect(body.files.truncated).toBe(false);
    expectRow(
      body.files.rows[0]!,
      { path: 'c.ts', reads: 2, chars: 300, w: 800, wRuns: 1, runs: 1, tasks: 1 },
      1200,
      1,
    );
    expectRow(
      body.files.rows[1]!,
      { path: 'a.ts', reads: 1, chars: 100, w: 400, wRuns: 1, runs: 1, tasks: 1 },
      1200,
      1,
    );
    expect(body.otherPaths.paths).toBe(0);
    // Known weight, nothing left over: a real zero, not unknown.
    expectBucket(body.otherPaths, 0, 0, 0, 1200, 1);
    expectBucket(body.overflow, 0, 0, 0, 1200, 1);
    expect(body.overflow).toMatchObject({ omitted: 0, runs: 0 });
    expectBucket(body.multiFile, 0, 0, 0, 1200, 1);
    expect(body.multiFile.runs).toBe(0);
    expect(body.steps.count).toBe(2);
    expectStep(body.steps.rows[0]!, {
      stepId: '04-implement',
      runs: 1,
      est: 300,
      prompt: 1050,
      n: 1,
      ratio: 300 / 1050,
      exceeds: false,
    });
    expectStep(body.steps.rows[1]!, {
      stepId: '03-plan',
      runs: 2,
      est: null,
      prompt: null,
      n: 0,
      ratio: null,
      exceeds: false,
    });
  });

  it('keeps unknown weight null, never 0, when no run of the scope has one', async () => {
    const body = await ok({ repositoryId: r3 });
    expectCoverage(body.coverage, {
      total: 3,
      recorded: 2,
      observable: 2,
      partial: 1,
      unobservable: 0,
      unrecorded: 1,
      inFlight: 0,
      weighted: 0,
    });
    expect(body.coverage.byProvider).toHaveLength(1);
    expect(body.coverage.byProvider[0]).toMatchObject({ provider: 'claude-code', total: 3 });
    // Exact reads and characters are floors that still count: 6 + 2 reads, 1000 + 250 chars.
    expect(body.totals.fileReads).toBe(8);
    expect(body.totals.fileChars).toBe(1250);
    expect(body.totals.estimatedTokens).toBeNull();
    expect(body.files).toMatchObject({ count: 2, truncated: false });
    expectRow(
      body.files.rows[0]!,
      { path: 'x.ts', reads: 3, chars: 650, w: null, wRuns: 0, runs: 2, tasks: 1 },
      0,
      0,
    );
    expectRow(
      body.files.rows[1]!,
      { path: 'y.ts', reads: 1, chars: 200, w: null, wRuns: 0, runs: 1, tasks: 1 },
      0,
      0,
    );
    expect(body.otherPaths.paths).toBe(0);
    expectBucket(body.otherPaths, 0, 0, null, 0, 0);
    expectBucket(body.overflow, 3, 300, null, 0, 0);
    expect(body.overflow).toMatchObject({ omitted: 3, runs: 1 });
    expectBucket(body.multiFile, 1, 100, null, 0, 0);
    expect(body.multiFile.runs).toBe(1);
    expect(body.steps.count).toBe(1);
    expectStep(body.steps.rows[0]!, {
      stepId: '03-plan',
      runs: 3,
      est: null,
      prompt: null,
      n: 0,
      ratio: null,
      exceeds: false,
    });
  });

  it('does not overflow 32 bits in characters, weights, reads or tokens', async () => {
    const body = await ok({ repositoryId: r4 });
    expect(body.coverage).toMatchObject({ total: 1, recorded: 1, observable: 1, weighted: 1 });
    expect(body.totals.fileReads).toBe(2_500_000_000);
    expect(body.totals.fileChars).toBe(5_000_000_000);
    expect(body.totals.estimatedTokens).toBe(2_250_000_000);
    expect(body.files.rows).toHaveLength(1);
    expectRow(
      body.files.rows[0]!,
      {
        path: 'huge.ts',
        reads: 2_500_000_000,
        chars: 5_000_000_000,
        w: 9_000_000_000,
        wRuns: 1,
        runs: 1,
        tasks: 1,
      },
      9_000_000_000,
      1,
    );
    expectBucket(body.otherPaths, 0, 0, 0, 9_000_000_000, 1);
    // Prompt side 3e9 + 1e9 = 4e9; est 9e9 / 4 = 2.25e9; ratio 0.5625.
    expectStep(body.steps.rows[0]!, {
      stepId: '06-huge',
      runs: 1,
      est: 2_250_000_000,
      prompt: 4_000_000_000,
      n: 1,
      ratio: 0.5625,
      exceeds: false,
    });
  });

  it('answers available false without a repository and rejects bad input', async () => {
    const none = await get({});
    expect(none.status).toBe(200);
    expect(none.body.available).toBe(false);
    expect(none.body).toMatchObject({ reason: 'repository-required' });
    expect(none.body.range).toBeDefined();
    expect(none.body.scope).toBeDefined();

    expect((await get({ repositoryId: 'not-a-uuid' })).status).toBe(400);
    expect((await get({ repositoryId: r1, cliProviderId: 'not-a-uuid' })).status).toBe(400);
    const tooLong = await get({
      repositoryId: r1,
      from: FROM.toISOString(),
      to: new Date(FROM.getTime() + 732 * DAY).toISOString(),
    });
    expect(tooLong.status).toBe(400);
    const longest = await get({
      repositoryId: r1,
      from: FROM.toISOString(),
      to: new Date(FROM.getTime() + 731 * DAY).toISOString(),
    });
    expect(longest.status).toBe(200);
  });
});
