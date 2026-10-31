import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { count, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { PROJECT_STATE_IMPORT_STEP_ID, namesGitData } from '@haive/shared/project-state';
import {
  ledgerImportedSince,
  loadNewestLiveArtifactAt,
  loadNewestLiveImportAt,
} from '@haive/shared/onboarding-admission';
import { supersedeGitDataArtifacts } from '../src/data-migrations.js';
import { loadLiveArtifacts } from '../src/step-engine/_upgrade-render.js';

const url = process.env.GIT_DATA_LEDGER_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/git_data_ledger_test')) {
  throw new Error('Use a dedicated git_data_ledger_test database for the git-data ledger test');
}

// The retire logs every id it retires, which for the 2,500-row case is one very long line.
vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'error';
});

type Row = typeof schema.onboardingArtifacts.$inferSelect;
type NewRow = typeof schema.onboardingArtifacts.$inferInsert;

interface PathCase {
  path: string;
  /** Hand-written: whether a live row at this path must be retired. */
  retire: boolean;
  kind: string;
}

// Labels are written by hand and also asserted against `namesGitData` below, so a typo here
// cannot make the rest of the file agree with a wrong rule. Invisible characters are escapes.
const PATHS: PathCase[] = [
  { path: '.git/config', retire: true, kind: 'literal' },
  { path: 'sub/.git/hooks/pre-commit', retire: true, kind: 'literal' },
  { path: '.git', retire: true, kind: 'bare' },
  { path: '.GIT/x', retire: true, kind: 'case' },
  { path: 'a/.gIt/b', retire: true, kind: 'case' },
  { path: 'git~1/x', retire: true, kind: 'short-name' },
  { path: 'GIT~1', retire: true, kind: 'short-name' },
  { path: '.git./x', retire: true, kind: 'trailing' },
  { path: '.git /x', retire: true, kind: 'trailing' },
  { path: 'git~1./x', retire: true, kind: 'trailing' },
  { path: '.git:s/x', retire: true, kind: 'stream' },
  { path: 'git~1:x', retire: true, kind: 'stream' },
  { path: '.g\u200cit/x', retire: true, kind: 'hfs-ignorable' },
  { path: '\ufeff.git/x', retire: true, kind: 'hfs-ignorable' },
  { path: 'a\\.git\\b', retire: true, kind: 'backslash' },
  { path: '.gitignore', retire: false, kind: 'near-miss' },
  { path: '.gitattributes', retire: false, kind: 'near-miss' },
  { path: '.gitmodules', retire: false, kind: 'near-miss' },
  { path: '.github/workflows/ci.yml', retire: false, kind: 'near-miss' },
  { path: '.git.md', retire: false, kind: 'near-miss' },
  { path: '.git-hooks/pre-push', retire: false, kind: 'near-miss' },
  { path: 'git~12/x', retire: false, kind: 'near-miss' },
  { path: 'x.git/y', retire: false, kind: 'near-miss' },
  { path: '.g\u200bit/x', retire: false, kind: 'near-miss' },
  { path: '.g\u0131t/x', retire: false, kind: 'near-miss' },
  { path: 'AGENTS.md', retire: false, kind: 'ordinary' },
  { path: '.claude/agents/code-reviewer.md', retire: false, kind: 'ordinary' },
  { path: '.claude/skills/github/SKILL.md', retire: false, kind: 'ordinary' },
];

/** Paths that also get an already-superseded sibling at the same (repository, path): history. */
const HISTORY_PATHS = new Set([
  '.git/config',
  'sub/.git/hooks/pre-commit',
  '.GIT/x',
  'git~1/x',
  '.gitignore',
  'AGENTS.md',
]);
const OLD_SUPERSEDED = new Date(Date.UTC(2026, 1, 2, 12, 0, 0, 654));

interface Mix {
  source: NewRow['source'];
  stepId: string;
  kind: string;
  task: boolean;
}
// The kinds of row a ledger holds. The last is an import marker: NULL task, `backfill` and the
// import step id, which the table's CHECK ties together and which needs `imported_at`.
const MIXES: Mix[] = [
  { source: 'onboarding', stepId: '12-post-onboarding', kind: 'agent', task: true },
  { source: 'upgrade', stepId: '02-upgrade-apply', kind: 'skill', task: true },
  { source: 'rollback', stepId: '04-upgrade-rollback', kind: 'agent', task: true },
  { source: 'backfill', stepId: '01-upgrade-plan', kind: 'cli-rules', task: true },
  { source: 'backfill', stepId: PROJECT_STATE_IMPORT_STEP_ID, kind: 'skill', task: false },
];
const MARKER = MIXES[4] as Mix;
const ONBOARDING = MIXES[0] as Mix;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** A path with its invisible and non-ASCII characters spelled out, for a failure message. */
const show = (s: string) =>
  JSON.stringify(s).replace(
    /[^\x20-\x7e]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

// The label checks need no database, so they run in a plain `pnpm test` as well.
describe('the git-data ledger fixture', () => {
  it('labels every path the way namesGitData reads it', () => {
    expect(PATHS.filter((c) => namesGitData(c.path) !== c.retire).map((c) => show(c.path))).toEqual(
      [],
    );
    expect(new Set(PATHS.map((c) => c.path)).size).toBe(PATHS.length);
    expect(PATHS.filter((c) => c.retire).length).toBeGreaterThan(0);
    expect(PATHS.filter((c) => !c.retire).length).toBeGreaterThan(0);
  });

  it('is retired by an exported supersedeGitDataArtifacts', () => {
    expect(typeof supersedeGitDataArtifacts, 'supersedeGitDataArtifacts must be exported').toBe(
      'function',
    );
  });
});

describe.skipIf(!url)('retiring ledger rows at git-data paths against Postgres', () => {
  let db: Database;
  let racer: Database;
  const users: string[] = [];

  beforeAll(async () => {
    db = createDatabase(url!);
    racer = createDatabase(url!);
    // The function under test reads the whole ledger, so a row some other run left behind would be
    // retired and counted here. Never deleted from here: it is not ours to delete.
    const [rows] = await db.select({ n: count() }).from(schema.onboardingArtifacts);
    if (rows!.n > 0) {
      throw new Error(
        `the scratch database holds ${rows!.n} ledger row(s) from an earlier run; drop and recreate it`,
      );
    }
  });
  afterEach(async () => {
    for (const id of users.splice(0)) await db.delete(schema.users).where(eq(schema.users.id, id));
    const [rows] = await db.select({ n: count() }).from(schema.onboardingArtifacts);
    expect(rows!.n, 'the test left ledger rows behind').toBe(0);
  });
  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await racer?.$client.end({ timeout: 5 });
  });

  interface Repo {
    id: string;
    userId: string;
    taskId: string;
  }

  async function makeUser(): Promise<string> {
    const id = randomUUID();
    users.push(id);
    await db.insert(schema.users).values({
      id,
      emailEncrypted: 'test',
      emailBlindIndex: id,
      passwordHash: 'test',
    });
    return id;
  }
  async function makeRepo(userId: string): Promise<Repo> {
    const id = randomUUID();
    const taskId = randomUUID();
    await db.insert(schema.repositories).values({
      id,
      userId,
      name: 'git-data-ledger-test',
      source: 'blank',
    });
    await db.insert(schema.tasks).values({
      id: taskId,
      userId,
      repositoryId: id,
      title: 'Onboard',
      type: 'onboarding',
      status: 'completed',
    });
    return { id, userId, taskId };
  }
  async function makeBundleItem(repo: Repo): Promise<string> {
    const bundleId = randomUUID();
    const itemId = randomUUID();
    await db.insert(schema.customBundles).values({
      id: bundleId,
      userId: repo.userId,
      repositoryId: repo.id,
      name: 'git-data-ledger-test',
      sourceType: 'zip',
      storageRoot: '/tmp/git-data-ledger-test',
    });
    await db.insert(schema.customBundleItems).values({
      id: itemId,
      bundleId,
      kind: 'agent',
      sourceFormat: 'claude-md',
      sourcePath: 'agents/git-data-ledger-test.md',
      normalizedSpec: {},
      contentHash: sha('item'),
    });
    return itemId;
  }

  interface RowSpec {
    repo: Repo;
    path: string;
    mix: Mix;
    /** Varies the optional columns, so each is filled on some rows and empty on others. */
    n: number;
    id?: string;
    generatedAt?: Date;
    updatedAt?: Date;
    supersededAt?: Date | null;
    importedAt?: Date | null;
    bundleItemId?: string | null;
  }
  function rowValues(s: RowSpec): NewRow {
    const generatedAt =
      s.generatedAt ?? new Date(Date.UTC(2026, 0, 1 + (s.n % 28), 10, s.n % 60, 0, 123));
    return {
      id: s.id ?? randomUUID(),
      userId: s.repo.userId,
      repositoryId: s.repo.id,
      taskId: s.mix.task ? s.repo.taskId : null,
      diskPath: s.path,
      templateId: `${s.mix.kind}.git-data-${s.n}`,
      templateKind: s.mix.kind,
      templateSchemaVersion: (s.n % 3) + 1,
      templateContentHash: sha(`template-${s.n}`),
      writtenHash: sha(`written-${s.n}`),
      writtenContent: s.n % 2 === 0 ? `content of ${s.n}` : null,
      lastObservedDiskHash: s.n % 3 === 0 ? sha(`disk-${s.n}`) : null,
      userModified: s.n % 4 === 0,
      formValuesSnapshot: s.n % 2 === 1 ? { seed: s.n, cliTargets: ['claude-code'] } : null,
      sourceStepId: s.mix.stepId,
      source: s.mix.source,
      haiveVersion: s.n % 2 === 0 ? '0.1.0' : null,
      generatedAt,
      updatedAt: s.updatedAt ?? new Date(generatedAt.getTime() + 3_600_000 + s.n),
      supersededAt: s.supersededAt ?? null,
      bundleItemId: s.bundleItemId ?? null,
      importedAt:
        s.importedAt !== undefined
          ? s.importedAt
          : !s.mix.task || s.n % 6 === 0
            ? generatedAt
            : null,
    };
  }
  async function insertRows(rows: NewRow[]): Promise<void> {
    for (let at = 0; at < rows.length; at += 200) {
      await db.insert(schema.onboardingArtifacts).values(rows.slice(at, at + 200));
    }
  }

  interface Seeded {
    id: string;
    path: PathCase;
    repoId: string;
    marker: boolean;
    /** An already-superseded sibling, not one of the live rows. */
    history: boolean;
  }
  const label = (s: Seeded) =>
    `${s.path.kind} ${show(s.path.path)}${s.history ? ' (history)' : ''}`;

  /** Two repositories of one user and one of another, one live row per path over every mix of
   *  source and kind, and a superseded sibling at some of them. */
  async function seedMixed(): Promise<Seeded[]> {
    const userA = await makeUser();
    const userB = await makeUser();
    const repos = [await makeRepo(userA), await makeRepo(userA), await makeRepo(userB)];
    const bundleItemId = await makeBundleItem(repos[0]!);
    const seeded: Seeded[] = [];
    const rows: NewRow[] = [];
    PATHS.forEach((path, n) => {
      const mix = MIXES[n % MIXES.length]!;
      const repo = repos[n % repos.length]!;
      const live = rowValues({
        repo,
        path: path.path,
        mix,
        n,
        bundleItemId: n % 7 === 0 ? bundleItemId : null,
      });
      rows.push(live);
      seeded.push({ id: live.id!, path, repoId: repo.id, marker: !mix.task, history: false });
      if (HISTORY_PATHS.has(path.path)) {
        const old = rowValues({
          repo,
          path: path.path,
          mix,
          n,
          supersededAt: OLD_SUPERSEDED,
          updatedAt: OLD_SUPERSEDED,
        });
        rows.push(old);
        seeded.push({ id: old.id!, path, repoId: repo.id, marker: !mix.task, history: true });
      }
    });
    await insertRows(rows);
    return seeded;
  }

  async function snapshot(): Promise<Map<string, Row>> {
    const rows = await db.select().from(schema.onboardingArtifacts);
    return new Map(rows.map((r) => [r.id, r]));
  }
  const liveIds = (rows: Map<string, Row>) =>
    [...rows.values()].filter((r) => r.supersededAt === null).map((r) => r.id);

  /** What a pass did to each row: retired (live -> superseded, ONLY those two columns moved),
   *  unchanged, or anything else (a different column moved, or the row set changed). */
  function diff(before: Map<string, Row>, after: Map<string, Row>) {
    const retired: string[] = [];
    const unchanged: string[] = [];
    const other: string[] = [];
    for (const [id, b] of before) {
      const a = after.get(id);
      if (!a) other.push(id);
      else if (isDeepStrictEqual(a, b)) unchanged.push(id);
      else if (
        b.supersededAt === null &&
        a.supersededAt !== null &&
        isDeepStrictEqual({ ...a, supersededAt: null, updatedAt: b.updatedAt }, b)
      )
        retired.push(id);
      else other.push(id);
    }
    for (const id of after.keys()) if (!before.has(id)) other.push(id);
    return { retired, unchanged, other };
  }

  async function runOnce() {
    const before = await snapshot();
    const t0 = Date.now();
    const ids = await supersedeGitDataArtifacts(db);
    const t1 = Date.now();
    const after = await snapshot();
    return { before, ids, t0, t1, after, ...diff(before, after) };
  }

  it('starts with every git-data row live, the state the retire has to change', async () => {
    const seeded = await seedMixed();
    const before = await snapshot();
    const live = seeded.filter((s) => !s.history);
    expect(liveIds(before).length).toBe(live.length);
    expect(live.filter((s) => s.path.retire).length).toBe(PATHS.filter((c) => c.retire).length);
    expect(
      [...before.values()].filter((r) => r.supersededAt === null && namesGitData(r.diskPath))
        .length,
    ).toBe(live.filter((s) => s.path.retire).length);
    expect(seeded.some((s) => s.marker && s.path.retire && !s.history)).toBe(true);
    expect(new Set(live.map((s) => s.repoId)).size).toBe(3);
  });

  it('retires every live row at a git-data path, in every spelling', async () => {
    const seeded = await seedMixed();
    const run = await runOnce();
    expect(
      seeded
        .filter((s) => !s.history && s.path.retire && run.after.get(s.id)!.supersededAt === null)
        .map((s) => label(s) + ' is still live'),
    ).toEqual([]);
    expect(
      [...run.after.values()].filter((r) => r.supersededAt === null && namesGitData(r.diskPath)),
    ).toEqual([]);
  });

  it('leaves near misses and ordinary rows byte-identical, updated_at included', async () => {
    const seeded = await seedMixed();
    const run = await runOnce();
    const unchanged = new Set(run.unchanged);
    expect(
      seeded
        .filter((s) => !s.path.retire && !unchanged.has(s.id))
        .map((s) => label(s) + ' changed'),
    ).toEqual([]);
    // And nothing was retired that the labels did not ask for.
    const asked = new Set(seeded.filter((s) => !s.history && s.path.retire).map((s) => s.id));
    expect(run.retired.filter((id) => !asked.has(id))).toEqual([]);
  });

  it('changes only superseded_at and updated_at, returns exactly the retired ids, keeps markers valid', async () => {
    const seeded = await seedMixed();
    const run = await runOnce();
    const asked = seeded.filter((s) => !s.history && s.path.retire);
    expect(run.other, 'rows that moved by more than the two columns').toEqual([]);
    expect([...run.ids].sort()).toEqual(asked.map((s) => s.id).sort());
    expect(new Set(run.ids).size, 'an id returned twice').toBe(run.ids.length);
    for (const s of asked) {
      const b = run.before.get(s.id)!;
      const a = run.after.get(s.id)!;
      expect(a.supersededAt, label(s)).toBeInstanceOf(Date);
      expect(a.supersededAt!.getTime(), label(s)).toBeGreaterThanOrEqual(run.t0);
      expect(a.supersededAt!.getTime(), label(s)).toBeLessThanOrEqual(run.t1);
      expect(a.updatedAt.getTime(), label(s)).toBe(a.supersededAt!.getTime());
      expect(a.updatedAt.getTime(), label(s)).toBeGreaterThan(b.updatedAt.getTime());
    }
    // An import marker at a git-data path retires, stays a marker and keeps its import date.
    const markers = asked.filter((s) => s.marker);
    expect(markers.length).toBeGreaterThan(0);
    for (const s of markers) {
      const b = run.before.get(s.id)!;
      const a = run.after.get(s.id)!;
      expect(b.taskId, label(s)).toBeNull();
      expect(b.importedAt, label(s)).not.toBeNull();
      expect(a.supersededAt, label(s)).not.toBeNull();
      expect(a.taskId, label(s)).toBeNull();
      expect(a.source, label(s)).toBe('backfill');
      expect(a.sourceStepId, label(s)).toBe(PROJECT_STATE_IMPORT_STEP_ID);
      expect(a.importedAt, label(s)).toEqual(b.importedAt);
    }
  });

  it('is a no-op the second time, and leaves a row superseded earlier with its old date', async () => {
    const seeded = await seedMixed();
    const first = await runOnce();
    expect(first.ids.length).toBe(seeded.filter((s) => !s.history && s.path.retire).length);
    const history = seeded.filter((s) => s.history && s.path.retire);
    expect(history.length).toBeGreaterThan(0);
    for (const s of history) {
      const a = first.after.get(s.id)!;
      expect(a.supersededAt, label(s)).toEqual(OLD_SUPERSEDED);
      expect(a.updatedAt, label(s)).toEqual(OLD_SUPERSEDED);
    }
    const second = await runOnce();
    expect(second.ids).toEqual([]);
    expect(second.other).toEqual([]);
    expect(second.retired).toEqual([]);
    expect(isDeepStrictEqual(second.after, first.after), 'the table changed on a second pass').toBe(
      true,
    );
  });

  it('gives two concurrent calls disjoint ids that together are the retired set', async () => {
    // Several rounds, each on fresh rows: a race is only a race when both calls read the rows
    // before either has written them.
    for (let round = 0; round < 3; round++) {
      const repo = await makeRepo(await makeUser());
      await insertRows(
        Array.from({ length: 400 }, (_, n) =>
          rowValues({ repo, path: `pkg-${n}/.git/config`, mix: ONBOARDING, n }),
        ),
      );
      const before = await snapshot();
      const [a, b] = await Promise.all([
        supersedeGitDataArtifacts(db),
        supersedeGitDataArtifacts(racer),
      ]);
      const after = await snapshot();
      const retired = new Set(diff(before, after).retired);
      expect(retired.size, `round ${round}`).toBe(400);
      expect(
        a.filter((id: string) => b.includes(id)),
        `round ${round}: ids returned by both`,
      ).toEqual([]);
      expect(new Set([...a, ...b]), `round ${round}`).toEqual(retired);
      expect(a.length + b.length, `round ${round}`).toBe(400);
      for (const id of users.splice(0))
        await db.delete(schema.users).where(eq(schema.users.id, id));
    }
  });

  it('retires more rows than one statement could carry, in one call', async () => {
    const repo = await makeRepo(await makeUser());
    const spellings = [
      (n: number) => `pkg-${n}/.git/config`,
      (n: number) => `pkg-${n}/.GIT/hooks/x`,
      (n: number) => `pkg-${n}/git~1/x`,
      (n: number) => `pkg-${n}/.git./x`,
      (n: number) => `pkg-${n}\\.git\\x`,
    ];
    const gitData = Array.from({ length: 2500 }, (_, n) => spellings[n % spellings.length]!(n));
    const ordinary = Array.from({ length: 50 }, (_, n) => `src/module-${n}/AGENTS.md`);
    expect(gitData.filter((p) => !namesGitData(p))).toEqual([]);
    expect(ordinary.filter((p) => namesGitData(p))).toEqual([]);
    expect(new Set(gitData).size).toBe(gitData.length);
    await insertRows([
      ...gitData.map((path, n) => rowValues({ repo, path, mix: MIXES[n % MIXES.length]!, n })),
      ...ordinary.map((path, n) => rowValues({ repo, path, mix: ONBOARDING, n })),
    ]);
    const run = await runOnce();
    expect(run.ids.length).toBe(2500);
    expect(new Set(run.ids).size).toBe(2500);
    expect(run.retired.length).toBe(2500);
    expect(run.other).toEqual([]);
    expect(run.unchanged.length).toBe(50);
    expect(liveIds(run.after).length).toBe(50);
  });

  it('retires more rows than postgres.js binds in one statement, in one call', async () => {
    // A statement carries at most 65534 bind parameters and an id is one, so only more rows than
    // that fail without chunking; the 2,500 above pass either way.
    const repo = await makeRepo(await makeUser());
    const total = 66_000;
    await db.execute(sql`
      INSERT INTO onboarding_artifacts (
        user_id, repository_id, task_id, disk_path, template_id, template_kind,
        template_schema_version, template_content_hash, written_hash, source_step_id, source
      )
      SELECT ${repo.userId}::uuid, ${repo.id}::uuid, ${repo.taskId}::uuid,
        'pkg-' || n || '/.git/config', 'agent.bulk-' || n, 'agent', 1,
        repeat('a', 64), repeat('b', 64), '12-post-onboarding', 'onboarding'
      FROM generate_series(1, ${total}::int) AS n
    `);
    await insertRows(
      Array.from({ length: 50 }, (_, n) =>
        rowValues({ repo, path: `src/module-${n}/AGENTS.md`, mix: ONBOARDING, n }),
      ),
    );
    const ids = await supersedeGitDataArtifacts(db);
    expect(ids.length).toBe(total);
    expect(new Set(ids).size).toBe(total);
    const [live] = await db
      .select({ n: count() })
      .from(schema.onboardingArtifacts)
      .where(isNull(schema.onboardingArtifacts.supersededAt));
    expect(live!.n).toBe(50);
  }, 60_000);

  it('stops the readers counting a retired row, and keeps the import history', async () => {
    const userA = await makeUser();
    const [r1, r2] = [await makeRepo(userA), await makeRepo(userA)];
    const D0 = new Date(Date.UTC(2026, 0, 15, 8, 0, 0, 0));
    const D1 = new Date(Date.UTC(2026, 1, 1, 8, 0, 0, 0));
    const D2 = new Date(Date.UTC(2026, 2, 1, 8, 0, 0, 0));
    const D3 = new Date(Date.UTC(2026, 3, 1, 8, 0, 0, 0));
    const D4 = new Date(Date.UTC(2026, 4, 1, 8, 0, 0, 0));
    const spec = (repo: Repo, path: string, mix: Mix, n: number, at: Date): NewRow =>
      rowValues({ repo, path, mix, n, generatedAt: at, importedAt: mix.task ? null : at });
    const ordinary = spec(r1, '.claude/agents/code-reviewer.md', ONBOARDING, 1, D1);
    const gitDataRow = spec(r1, '.git/hooks/pre-commit', ONBOARDING, 2, D2);
    const gitDataMarker = spec(r1, '.GIT/info/exclude', MARKER, 3, D3);
    const ordinaryMarker = spec(r1, 'AGENTS.md', MARKER, 4, D0);
    // The only live row of this repository is a git-data import marker.
    const onlyMarker = spec(r2, '.git/hooks/post-merge', MARKER, 5, D4);
    await insertRows([ordinary, gitDataRow, gitDataMarker, ordinaryMarker, onlyMarker]);
    const repoIds = [r1.id, r2.id];
    const at = (m: Map<string, Date>, repo: Repo) => m.get(repo.id)?.getTime();

    expect((await loadLiveArtifacts(db, r1.id)).length).toBe(4);
    expect(at(await loadNewestLiveImportAt(db, userA, repoIds), r1)).toBe(D3.getTime());
    expect(at(await loadNewestLiveImportAt(db, userA, repoIds), r2)).toBe(D4.getTime());
    expect(at(await loadNewestLiveArtifactAt(db, userA, repoIds), r1)).toBe(D3.getTime());
    expect(at(await loadNewestLiveArtifactAt(db, userA, repoIds), r2)).toBe(D4.getTime());
    const earlier = new Date(D4.getTime() - 24 * 3_600_000);
    expect(await ledgerImportedSince(db, r2.id, earlier)).toBe(true);

    const ids = await supersedeGitDataArtifacts(db);
    expect([...ids].sort()).toEqual([gitDataRow.id!, gitDataMarker.id!, onlyMarker.id!].sort());

    expect((await loadLiveArtifacts(db, r1.id)).map((r) => r.id).sort()).toEqual(
      [ordinary.id!, ordinaryMarker.id!].sort(),
    );
    expect(await loadLiveArtifacts(db, r2.id)).toEqual([]);
    // The newest live marker moves back to the ordinary one, and the repository whose only live
    // row was a git-data marker is no longer listed: the accepted shift.
    const imports = await loadNewestLiveImportAt(db, userA, repoIds);
    expect(at(imports, r1)).toBe(D0.getTime());
    expect(imports.has(r2.id)).toBe(false);
    const artifacts = await loadNewestLiveArtifactAt(db, userA, repoIds);
    expect(at(artifacts, r1)).toBe(D1.getTime());
    expect(artifacts.has(r2.id)).toBe(false);
    // The ledger still remembers the import, live or not.
    expect(await ledgerImportedSince(db, r2.id, earlier)).toBe(true);
    expect(await ledgerImportedSince(db, r2.id, new Date(D4.getTime() + 24 * 3_600_000))).toBe(
      false,
    );
  });
});
