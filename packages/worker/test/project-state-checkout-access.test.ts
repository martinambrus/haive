import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireRootClaim,
  schema,
  type Database,
  type RootClaimHandle,
  type RootClaimKind,
} from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  buildRepoCliRulesBlock,
  configService,
  extractRegion,
  CLI_RULES_END,
  CLI_RULES_START,
  logger,
} from '@haive/shared';
import {
  emptyProjectState,
  readRenderContextColumn,
  renderProjectState,
  type ProjectRender,
  type ProjectStateRecord,
} from '@haive/shared/project-state';
import { withPlanCheckoutAccess } from '../src/repo/checkout-access-scope.js';
import { refreshProjectStateOutcome } from '../src/project-state/refresh.js';
import { syncProjectStateFromCheckout } from '../src/project-state/sync.js';
import { reconcileImportedRules } from '../src/project-state/task-end-rules.js';
import { watchCheckout } from '../src/project-state/watch.js';
import {
  ProjectStateCheckoutHeldError,
  ProjectStateMovedError,
  recoverProjectStateWrite,
  writeProjectStateColumn,
  writeProjectStateRecord,
} from '../src/project-state/write.js';
import { gitTemplate } from './support/git-template.js';

const STATE_DIR = '.haive-data/state';

const emptyRepository = gitTemplate(async (dir) => {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
});
const committedRepository = gitTemplate(async (dir) => {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['commit', '--allow-empty', '-qm', 'initial'], {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@local',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@local',
    },
  });
});
const claims: RootClaimHandle[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const claim of claims.splice(0)) await claim.release().catch(() => undefined);
});

/** The fake keeps an upsert's SQL expressions unevaluated in its rows; they are not data. */
const json = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (_key, member: unknown) =>
      member !== null &&
      typeof member === 'object' &&
      !Array.isArray(member) &&
      !(member instanceof Date) &&
      Object.getPrototypeOf(member) !== Object.prototype
        ? '[expression]'
        : member,
    ),
  ) as unknown;

/** The conditions under which project state may neither read nor write the checkout. A real
 *  rebuild or refresh publishes status 'cloning' with its claim; the others hold a ready row. */
interface Condition {
  name: string;
  claim: RootClaimKind | null;
  status: 'ready' | 'cloning' | 'error';
  /** Refused by the code before the checkout policy existed. */
  alreadyHeld?: boolean;
}
const CONDITIONS: Condition[] = [
  { name: 'a live rebuild claim at status cloning', claim: 'rebuild', status: 'cloning' },
  { name: 'a live refresh claim at status cloning', claim: 'refresh', status: 'cloning' },
  { name: 'a live edit claim', claim: 'edit', status: 'ready' },
  { name: 'a live mutation claim', claim: 'mutation', status: 'ready' },
  { name: 'a live verify claim', claim: 'verify', status: 'ready' },
  { name: 'a live reset claim', claim: 'reset', status: 'ready', alreadyHeld: true },
  { name: 'no claim at status cloning', claim: null, status: 'cloning' },
  { name: 'no claim at status error', claim: null, status: 'error' },
];
const byName = CONDITIONS.map((c) => [c.name, c] as const);

// ---- fixtures ---------------------------------------------------------------------------------

const context = (): Record<string, unknown> => ({
  projectInfo: {
    name: 'acme',
    framework: 'drupal',
    primaryLanguage: 'php',
    description: null,
    localUrl: null,
    databaseType: 'postgres',
    databaseVersion: '17',
    webserver: 'nginx-fpm',
    docroot: 'web',
    runtimeVersions: { php: '8.3' },
    testFrameworks: ['phpunit'],
    testPaths: ['tests'],
    buildTool: 'composer',
    commands: [],
    containerType: 'ddev',
  },
  framework: 'drupal',
  acceptedAgentIds: ['security-auditor', 'code-reviewer'],
  customAgentSpecs: [
    { id: 'billing-expert', title: 'Billing expert', description: 'Knows the billing module' },
  ],
  agentTargets: [{ dir: '.claude/agents', format: 'markdown', supportsLsp: true }],
  lspLanguages: ['php-extended', 'css'],
  rtkEnabled: true,
  enabledCliProviders: [{ name: 'claude-code', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' }],
});
const renamed = (): Record<string, unknown> => ({
  ...context(),
  projectInfo: { ...(context().projectInfo as object), name: 'acme-renamed' },
});

const render = (over: Partial<ProjectRender> = {}): ProjectRender => ({
  projectInfo: {
    name: 'acme',
    framework: 'drupal',
    docroot: 'web',
    runtimeVersions: { php: '8.3' },
  },
  framework: 'drupal',
  acceptedAgentIds: ['code-reviewer', 'security-auditor'],
  customAgentSpecs: [
    { id: 'billing-expert', title: 'Billing expert', description: 'Knows the billing module' },
  ],
  lspLanguages: ['css', 'php-extended'],
  ...over,
});
const FIRST = render();
const SECOND = render({ framework: 'drupal11', lspLanguages: ['css', 'php-extended', 'twig'] });
const record = (r: ProjectRender): ProjectStateRecord => ({ ...emptyProjectState(), render: r });

async function setup(repository = emptyRepository) {
  const { dir: root } = await repository.copy();
  const id = randomUUID();
  const userId = randomUUID();
  const fake = createFakeDb({
    auditEvents: schema.auditEvents,
    repositories: schema.repositories,
    projectStateSync: schema.projectStateSync,
    projectStateOutbox: schema.projectStateOutbox,
    projectStateConflicts: schema.projectStateConflicts,
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    onboardingArtifacts: schema.onboardingArtifacts,
    cliProviders: schema.cliProviders,
    customBundles: schema.customBundles,
    customBundleItems: schema.customBundleItems,
    planNodes: schema.planNodes,
    planNodeEdges: schema.planNodeEdges,
    planNodeCodeLinks: schema.planNodeCodeLinks,
    planMirrorState: schema.planMirrorState,
  });
  fake.insert(schema.repositories, {
    id,
    userId,
    name: 'acme',
    source: 'blank',
    status: 'ready',
    storagePath: root,
    rtkEnabled: null,
    updatedAt: new Date(1000),
  });
  // The fake cannot evaluate setOutboxError's `IS DISTINCT FROM` filter. A reason-only update of the
  // outbox is applied by repository instead; real Postgres (the gated file) covers the filter.
  const db = new Proxy(fake.db as unknown as Database, {
    get(target, prop, receiver) {
      if (prop !== 'update') return Reflect.get(target, prop, receiver) as unknown;
      return (table: Parameters<Database['update']>[0]) => {
        const real = target.update(table);
        if (table !== schema.projectStateOutbox) return real;
        return {
          set: (values: Record<string, unknown>) =>
            typeof values.lastError === 'string'
              ? {
                  where: async () => {
                    await target
                      .update(table)
                      .set(values as never)
                      .where(eq(schema.projectStateOutbox.repositoryId, id));
                  },
                }
              : real.set(values as never),
        };
      };
    },
  });
  const hook = { onLock: null as ((nth: number, key: string) => void | Promise<void>) | null };
  let locks = 0;
  const arm = (fn: ((nth: number, key: string) => void | Promise<void>) | null) => {
    locks = 0;
    hook.onLock = fn;
  };
  const lockKeys: string[] = [];
  fake.hooks.beforeLock = async (key) => {
    locks += 1;
    lockKeys.push(key);
    await hook.onLock?.(locks, key);
  };
  // rows() hands back copies: a change goes through the database like any other writer's.
  const repoRow = () => fake.rows(schema.repositories)[0]!;
  const outboxRow = () => fake.rows(schema.projectStateOutbox)[0]!;
  const setRepo = async (values: Record<string, unknown>) => {
    await fake.db.update(schema.repositories).set(values).where(eq(schema.repositories.id, id));
  };
  const setOutbox = async (values: Record<string, unknown>) => {
    await fake.db
      .update(schema.projectStateOutbox)
      .set(values)
      .where(eq(schema.projectStateOutbox.repositoryId, id));
  };

  const put = async (rel: string, data: string) => {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), data);
  };
  const putRecordSync = (r: ProjectStateRecord) => {
    for (const [rel, text] of renderProjectState(r)) {
      const abs = join(root, STATE_DIR, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text);
    }
  };

  /** Applies a condition and returns what ends it. */
  const hold = async (c: Condition): Promise<() => Promise<void>> => {
    let handle: RootClaimHandle | null = null;
    if (c.claim) {
      handle = await acquireRootClaim(db, id, c.claim);
      expect(handle).not.toBeNull();
      claims.push(handle!);
    }
    await setRepo({ status: c.status });
    return async () => {
      await handle?.release();
      await setRepo({ status: 'ready' });
    };
  };

  /** A repository whose record was written once, then changed in its column and marked dirty:
   *  the next write has files to change. */
  const dirty = async () => {
    await writeProjectStateRecord(db, {
      repositoryId: id,
      repoPath: root,
      context: context() as never,
      rtkChoiceRecorded: true,
    });
    const changed = structuredClone(repoRow().renderContext) as Record<string, unknown>;
    changed.projectInfo = { ...(changed.projectInfo as object), name: 'acme-renamed' };
    await setRepo({ renderContext: changed });
    // Literals: the fake keeps the writer's LEAST/GREATEST stamp unevaluated.
    await setOutbox({ revision: 2, writtenRevision: 1, lastError: null, writeIntent: null });
  };
  const columnArgs = () => {
    const read = readRenderContextColumn(repoRow().renderContext as never);
    if (read.kind !== 'column') throw new Error('the fixture holds no render context');
    return { column: read.column, expectedColumns: [repoRow().renderContext] };
  };
  const writeColumn = () =>
    writeProjectStateColumn(db, { repositoryId: id, repoPath: root, ...columnArgs() });
  const writeRecord = () =>
    writeProjectStateRecord(db, {
      repositoryId: id,
      repoPath: root,
      context: renamed() as never,
      rtkChoiceRecorded: true,
    });

  /** The writer's first phase committed its journal, the second never ran: an interrupted write. */
  const interrupt = async () => {
    arm((nth) => {
      if (nth === 3) throw new Error('interrupted before the second phase');
    });
    await expect(
      writeProjectStateColumn(db, {
        repositoryId: id,
        repoPath: root,
        keepColumnOnFailure: true,
        ...columnArgs(),
      }),
    ).rejects.toThrow();
    arm(null);
    expect(outboxRow().writeIntent).toBeTruthy();
  };

  return {
    root,
    id,
    userId,
    fake,
    db,
    hook,
    arm,
    lockKeys,
    repoRow,
    outboxRow,
    setRepo,
    setOutbox,
    put,
    putRecordSync,
    hold,
    dirty,
    columnArgs,
    writeColumn,
    writeRecord,
    interrupt,
  };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

/** Every file of the checkout with its bytes, the git directory aside. */
async function tree(root: string, sub = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const base = join(root, sub);
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = sub === '' ? entry.name : `${sub}/${entry.name}`;
    if (rel === '.git') continue;
    if (entry.isDirectory()) Object.assign(out, await tree(root, rel));
    else if (entry.isFile()) out[rel] = (await readFile(join(root, rel))).toString('base64');
  }
  return out;
}

const records = (s: Fixture) => ({
  repositories: json(s.fake.rows(schema.repositories)),
  sync: json(s.fake.rows(schema.projectStateSync)),
  conflicts: json(s.fake.rows(schema.projectStateConflicts)),
  artifacts: json(s.fake.rows(schema.onboardingArtifacts)),
  audit: json(s.fake.rows(schema.auditEvents)),
});
const outboxAll = (s: Fixture) => {
  const row = s.outboxRow();
  return json({
    revision: row.revision,
    writtenRevision: row.writtenRevision,
    writeIntent: row.writeIntent,
    rulesReconcileIntent: row.rulesReconcileIntent,
    lastError: row.lastError,
    updatedAt: row.updatedAt,
  });
};
const outboxCore = (s: Fixture) => {
  const row = s.outboxRow();
  return json({
    revision: row.revision,
    writtenRevision: row.writtenRevision,
    writeIntent: row.writeIntent,
    rulesReconcileIntent: row.rulesReconcileIntent,
  });
};

// ---- C1: the writer ---------------------------------------------------------------------------

describe('member 1: the project-state writer under a held checkout', () => {
  it.each(byName)(
    'writeProjectStateColumn is refused under %s and changes nothing',
    async (_n, c) => {
      const s = await setup();
      await s.dirty();
      const release = await s.hold(c);
      const files = await tree(s.root);
      const rows = records(s);
      const outbox = outboxAll(s);

      await expect(s.writeColumn()).rejects.toBeInstanceOf(ProjectStateCheckoutHeldError);

      expect(await tree(s.root)).toEqual(files);
      expect(records(s)).toEqual(rows);
      expect(outboxAll(s)).toEqual(outbox);
      await release();
      await s.writeColumn();
      expect(await tree(s.root)).not.toEqual(files);
    },
  );

  it.each(byName)(
    'writeProjectStateRecord is refused under %s and changes nothing',
    async (_n, c) => {
      const s = await setup();
      await s.dirty();
      const release = await s.hold(c);
      const files = await tree(s.root);
      const rows = records(s);
      const outbox = outboxAll(s);

      await expect(s.writeRecord()).rejects.toBeInstanceOf(ProjectStateCheckoutHeldError);

      expect(await tree(s.root)).toEqual(files);
      expect(records(s)).toEqual(rows);
      expect(outboxAll(s)).toEqual(outbox);
      await release();
      await s.writeRecord();
      expect(await tree(s.root)).not.toEqual(files);
    },
  );

  it.each(byName)(
    'refreshProjectStateOutcome holds under %s, keeps the row dirty with one stable reason and writes after the release',
    async (_n, c) => {
      const s = await setup();
      await s.dirty();
      const release = await s.hold(c);
      const files = await tree(s.root);
      const rows = records(s);
      const core = outboxCore(s);

      const first = await refreshProjectStateOutcome(s.db, s.id);

      expect(await tree(s.root)).toEqual(files);
      expect(records(s)).toEqual(rows);
      expect(outboxCore(s)).toEqual(core);
      expect(first).toMatchObject({ outcome: 'held', reason: 'checkout' });
      const held = s.outboxRow();
      expect(held.writtenRevision as number).toBeLessThan(held.revision as number);
      expect(held.lastError).not.toBeNull();
      const reason = held.lastError;

      const second = await refreshProjectStateOutcome(s.db, s.id);

      expect(second).toMatchObject({ outcome: 'held', reason: 'checkout' });
      expect(s.outboxRow().lastError).toBe(reason);
      expect(outboxCore(s)).toEqual(core);
      expect(await tree(s.root)).toEqual(files);

      await release();
      expect(await refreshProjectStateOutcome(s.db, s.id)).toMatchObject({ outcome: 'written' });
      // The stamp itself is SQL the fake does not evaluate; the gated file checks the revisions.
      expect(s.outboxRow().lastError).toBeNull();
      expect(s.outboxRow().writeIntent).toBeNull();
      expect(await tree(s.root)).not.toEqual(files);
    },
  );
});

describe('member 1: a claim that appears between the two phases of a write', () => {
  it.each([
    ['a live rebuild claim at status cloning', 'rebuild', 'cloning'],
    ['a live edit claim', 'edit', 'ready'],
    ['a live mutation claim', 'mutation', 'ready'],
  ] as const)(
    'refuses the second phase under %s and leaves the journal for recovery',
    async (_n, kind, status) => {
      const s = await setup();
      await s.dirty();
      const files = await tree(s.root, STATE_DIR);
      let release: (() => Promise<void>) | null = null;
      s.arm(async (nth) => {
        if (nth === 3) release = await s.hold({ name: kind, claim: kind, status });
      });

      const outcome = await s.writeColumn().then(
        () => 'resolved' as const,
        (err: unknown) => err,
      );

      expect(release).not.toBeNull();
      expect(outcome).toBeInstanceOf(ProjectStateCheckoutHeldError);
      expect(await tree(s.root, STATE_DIR)).toEqual(files);
      const held = s.outboxRow();
      expect(held.writeIntent).toBeTruthy();
      expect(held.writtenRevision as number).toBeLessThan(held.revision as number);

      s.arm(null);
      await release!();
      await recoverProjectStateWrite(s.db, s.id, s.root);
      await s.writeColumn();
      expect(s.outboxRow().writeIntent).toBeNull();
      expect(await tree(s.root, STATE_DIR)).not.toEqual(files);
    },
  );
});

describe('member 1: recovery of an interrupted write under a held checkout', () => {
  it.each(byName)('restores nothing under %s', async (_n, c) => {
    const s = await setup();
    await s.dirty();
    await s.interrupt();
    const release = await s.hold(c);
    const files = await tree(s.root);
    const rows = records(s);
    const outbox = outboxAll(s);

    await expect(recoverProjectStateWrite(s.db, s.id, s.root)).rejects.toBeInstanceOf(
      ProjectStateCheckoutHeldError,
    );

    expect(await tree(s.root)).toEqual(files);
    expect(records(s)).toEqual(rows);
    expect(outboxAll(s)).toEqual(outbox);
    expect(s.outboxRow().writeIntent).toBeTruthy();
    await release();
    await recoverProjectStateWrite(s.db, s.id, s.root);
    expect(s.outboxRow().writeIntent).toBeNull();
  });
});

describe('priority between an open git operation and a claim', () => {
  it('keeps the git-operation refusal ahead of a claim hold', async () => {
    const s = await setup();
    await s.dirty();
    await writeFile(join(s.root, '.git/MERGE_HEAD'), `${'a'.repeat(40)}\n`);
    await s.hold({ name: 'rebuild', claim: 'rebuild', status: 'cloning' });
    const files = await tree(s.root);

    const outcome = await writeProjectStateColumn(s.db, {
      repositoryId: s.id,
      repoPath: s.root,
      refuseDuringGitOperation: true,
      ...s.columnArgs(),
    }).then(
      () => 'resolved' as const,
      (err: unknown) => err,
    );

    expect(outcome).toBeInstanceOf(ProjectStateMovedError);
    expect(outcome).not.toBeInstanceOf(ProjectStateCheckoutHeldError);
    expect(await tree(s.root)).toEqual(files);
  });
});

// ---- C2: the sync -----------------------------------------------------------------------------

describe('member 2: the checkout sync under a held checkout', () => {
  const sync = (s: Fixture) =>
    syncProjectStateFromCheckout(s.db, { repositoryId: s.id, repoPath: s.root });

  it.each(byName)('holds with checkout_unavailable under %s and imports nothing', async (_n, c) => {
    const s = await setup();
    s.putRecordSync(record(FIRST));
    const release = await s.hold(c);
    const rows = records(s);
    const files = await tree(s.root);

    const result = await sync(s);

    expect(records(s)).toEqual(rows);
    expect(await tree(s.root)).toEqual(files);
    expect(result).toMatchObject({ outcome: 'held', code: 'checkout_unavailable' });
    await release();
    expect(await sync(s)).toMatchObject({ outcome: 'applied' });
  });

  it.each([
    ['a live rebuild claim at status cloning', 'rebuild', 'cloning'],
    ['a live edit claim', 'edit', 'ready'],
  ] as const)(
    'judges %s before it reads the record, even when the record moves',
    async (_n, kind, status) => {
      const s = await setup();
      s.putRecordSync(record(FIRST));
      const release = await s.hold({ name: kind, claim: kind, status });
      const rows = records(s);
      let rewritten = false;
      s.hook.onLock = (_nth, key) => {
        if (key !== `project-state:${s.id}` || rewritten) return;
        rewritten = true;
        s.putRecordSync(record(SECOND));
      };

      const result = await sync(s);

      expect(result).toMatchObject({ outcome: 'held', code: 'checkout_unavailable' });
      expect(records(s)).toEqual(rows);
      await release();
      s.hook.onLock = null;
      expect(await sync(s)).toMatchObject({ outcome: 'applied' });
    },
  );
});

// ---- C3: the task-end rules reconcile ---------------------------------------------------------

describe('member 3: the imported rules reconcile under a held checkout', () => {
  const BEFORE = 'PLANNED RULES\n';
  const AFTER = 'TEAM RULES\n';

  async function owed() {
    const s = await setup();
    const taskId = randomUUID();
    s.fake.insert(schema.tasks, {
      id: taskId,
      userId: s.userId,
      repositoryId: s.id,
      type: 'onboarding_upgrade',
      status: 'completed',
    });
    await s.setRepo({ agentRulesOverride: AFTER });
    s.fake.insert(schema.projectStateOutbox, {
      repositoryId: s.id,
      revision: 1,
      writtenRevision: 1,
      updatedAt: new Date(0),
      rulesReconcileIntent: { phase: 'ready', taskId, before: BEFORE, after: AFTER, resetAt: null },
    });
    await s.put('AGENTS.md', `# Project\n\n${buildRepoCliRulesBlock(BEFORE)}\nUser notes\n`);
    return s;
  }

  it.each(byName)('writes neither AGENTS.md nor its ledger under %s', async (_n, c) => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const s = await owed();
    const release = await s.hold(c);
    const files = await tree(s.root);
    const rows = records(s);
    const core = outboxCore(s);

    await reconcileImportedRules(s.db, s.id, s.root);

    expect(await tree(s.root)).toEqual(files);
    expect(records(s)).toEqual(rows);
    expect(s.fake.rows(schema.onboardingArtifacts)).toHaveLength(0);
    expect(outboxCore(s)).toEqual(core);
    expect(s.outboxRow().rulesReconcileIntent).toMatchObject({ phase: 'ready' });

    await release();
    await reconcileImportedRules(s.db, s.id, s.root);
    const text = await readFile(join(s.root, 'AGENTS.md'), 'utf8');
    expect(extractRegion(text, CLI_RULES_START, CLI_RULES_END)).toContain('TEAM RULES');
    expect(text).toContain('User notes');
    expect(s.outboxRow().rulesReconcileIntent).toBeNull();
    expect(s.fake.rows(schema.onboardingArtifacts)).toHaveLength(1);
  });
});

// ---- C4: the watcher, expected not to reproduce -----------------------------------------------

describe('member 3: the checkout watcher already admits through the root claim', () => {
  async function watched() {
    const s = await setup(committedRepository);
    s.putRecordSync(record(FIRST));
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
    // The fake cannot evaluate the branch update's column-to-column filter; it is not under test.
    const db = new Proxy(s.db, {
      get(target, prop, receiver) {
        if (prop !== 'update') return Reflect.get(target, prop, receiver) as unknown;
        return (table: Parameters<Database['update']>[0]) => {
          const real = target.update(table);
          if (table !== schema.repositories) return real;
          return {
            set: (values: Record<string, unknown>) =>
              'checkoutBranch' in values ? { where: async () => [] } : real.set(values as never),
          };
        };
      },
    });
    return { ...s, db };
  }

  it.each(byName)('returns held under %s and imports nothing', async (_n, c) => {
    const s = await watched();
    const release = await s.hold(c);
    const rows = records(s);
    const files = await tree(s.root);

    expect(await watchCheckout(s.db, s.id)).toBe('held');

    expect(records(s)).toEqual(rows);
    expect(await tree(s.root)).toEqual(files);
    await release();
    expect(await watchCheckout(s.db, s.id)).toBe('synced');
    expect(readRenderContextColumn(s.repoRow().renderContext as never).kind).toBe('column');
  });
});

// ---- C6: negative controls --------------------------------------------------------------------

describe('a holder of its own claim is not refused', () => {
  const own = async (s: Fixture, kind: RootClaimKind, status: 'ready' | 'cloning') => {
    const handle = await acquireRootClaim(s.db, s.id, kind);
    expect(handle).not.toBeNull();
    claims.push(handle!);
    await s.setRepo({ status });
    return handle!;
  };

  it('writes a record under its own rebuild claim at status cloning, in preparation scope', async () => {
    const s = await setup();
    await s.dirty();
    const files = await tree(s.root);
    const owner = await own(s, 'rebuild', 'cloning');

    await withPlanCheckoutAccess({ mode: 'preparation', owner }, () => s.writeColumn());

    expect(await tree(s.root)).not.toEqual(files);
  });

  it('syncs under its own rebuild claim at status cloning, in preparation scope', async () => {
    const s = await setup();
    s.putRecordSync(record(FIRST));
    const owner = await own(s, 'rebuild', 'cloning');

    const result = await withPlanCheckoutAccess({ mode: 'preparation', owner }, () =>
      syncProjectStateFromCheckout(s.db, { repositoryId: s.id, repoPath: s.root }),
    );

    expect(result).toMatchObject({ outcome: 'applied' });
  });

  it('recovers an interrupted write under its own rebuild claim at status cloning, in preparation scope', async () => {
    const s = await setup();
    await s.dirty();
    await s.interrupt();
    const owner = await own(s, 'rebuild', 'cloning');

    await withPlanCheckoutAccess({ mode: 'preparation', owner }, () =>
      recoverProjectStateWrite(s.db, s.id, s.root),
    );

    expect(s.outboxRow().writeIntent).toBeNull();
  });

  it('syncs under its own edit claim, in projection scope', async () => {
    const s = await setup();
    s.putRecordSync(record(FIRST));
    const owner = await own(s, 'edit', 'ready');

    const result = await withPlanCheckoutAccess({ mode: 'projection', owner }, () =>
      syncProjectStateFromCheckout(s.db, { repositoryId: s.id, repoPath: s.root }),
    );

    expect(result).toMatchObject({ outcome: 'applied' });
  });

  it('writes at status ready with no claim', async () => {
    const s = await setup();
    await s.dirty();
    const files = await tree(s.root);

    await s.writeColumn();
    expect(await tree(s.root)).not.toEqual(files);
  });
});
