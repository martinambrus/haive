import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { and, eq, type SQL } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema } from '@haive/database';
import { configService } from '@haive/shared';
import { emptyProjectState, renderProjectState } from '@haive/shared/project-state';

const seam = vi.hoisted(() => ({ afterPrecheck: null as (() => Promise<void>) | null, refs: 0 }));
vi.mock('../src/repo/git-exec.js', async (load) => {
  const real = await load<typeof import('../src/repo/git-exec.js')>();
  return {
    ...real,
    gitRun: async (...args: Parameters<typeof real.gitRun>) => {
      const result = await real.gitRun(...args);
      if (args[1][0] === 'symbolic-ref' && ++seam.refs === 2) await seam.afterPrecheck?.();
      return result;
    },
  };
});
import { watchCheckout, sweepCheckoutRepositories } from '../src/project-state/watch.js';
import { readCheckout } from '../src/project-state/sync.js';
import { markProjectStateDirty } from '@haive/shared/project-state-outbox';
import { writeProjectStateColumn } from '../src/project-state/write.js';

// An exclusive opt-in fixture, never DATABASE_URL or the development server.
const url = process.env.T117_DATABASE_URL;
if (
  url &&
  (!/^\/codex_t117_[a-z0-9_]+$/.test(new URL(url).pathname) ||
    ['', '5432'].includes(new URL(url).port))
)
  throw new Error('T117 requires its exclusive scratch database');
const db = url ? createDatabase(url) : null;
const users: string[] = [];
const dirs: string[] = [];
const context = (name = 'first') => ({
  projectInfo: { name },
  framework: null,
  acceptedAgentIds: [],
  customAgentSpecs: [],
  lspLanguages: [],
});
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@local',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@local',
};
const git = (root: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
const stateOf = async (id: string) =>
  (
    await db!
      .select()
      .from(schema.projectStateSync)
      .where(eq(schema.projectStateSync.repositoryId, id))
  )[0];
const repoOf = async (id: string) =>
  (await db!.select().from(schema.repositories).where(eq(schema.repositories.id, id)))[0]!;
async function disk(root: string, name = 'first', version = '1.0.0') {
  for (const [rel, text] of renderProjectState({
    ...emptyProjectState(),
    render: context(name),
    settings: { 'rtk-version': version },
  })) {
    const path = join(root, '.haive-data/state', rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 't117-checkout-'));
  dirs.push(root);
  git(root, 'init', '-q', '-b', 'main');
  await disk(root);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'initial record');
  const userId = randomUUID();
  users.push(userId);
  await db!.insert(schema.users).values({
    id: userId,
    emailEncrypted: 'fixture',
    emailBlindIndex: userId,
    passwordHash: 'fixture',
  });
  const [repo] = await db!
    .insert(schema.repositories)
    .values({
      userId,
      source: 'blank',
      name: 'fixture',
      storagePath: root,
      branch: 'stored-name-is-not-actual',
    })
    .returning();
  return { root, id: repo!.id, userId };
}
afterEach(async () => {
  seam.afterPrecheck = null;
  seam.refs = 0;
  for (const id of users.splice(0)) await db!.delete(schema.users).where(eq(schema.users.id, id));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
});

describe.skipIf(!url)('checkout watch on real Git and PostgreSQL', () => {
  const enabled = () => vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
  it('learns a plain fast-forward without an outbox, then detects same-HEAD same-size edits and HEAD-only moves', async () => {
    enabled();
    const s = await fixture();
    expect(await watchCheckout(db!, s.id)).toBe('synced');
    expect((await repoOf(s.id)).rtkVersion).toBe('1.0.0');
    const first = git(s.root, 'rev-parse', 'HEAD');
    git(s.root, 'checkout', '-qb', 'teammate');
    await disk(s.root, 'other', '2.0.0');
    git(s.root, 'add', '-A');
    git(s.root, 'commit', '-qm', 'teammate change');
    const next = git(s.root, 'rev-parse', 'HEAD');
    git(s.root, 'checkout', '-q', 'main');
    git(s.root, 'merge', '--ff-only', 'teammate');
    expect(first).not.toBe(next);
    expect(await watchCheckout(db!, s.id)).toBe('synced');
    expect((await repoOf(s.id)).renderContext).toMatchObject(context('other'));
    expect((await stateOf(s.id))?.syncedHead).toBe(next);
    const setting = join(s.root, '.haive-data/state/settings/rtk-version.json');
    const metadata = await stat(setting);
    await writeFile(setting, '"3.0.0"\n');
    await utimes(setting, metadata.atime, metadata.mtime);
    expect(await watchCheckout(db!, s.id)).toBe('synced');
    expect((await repoOf(s.id)).rtkVersion).toBe('3.0.0');
    git(s.root, 'commit', '--allow-empty', '-qm', 'HEAD only');
    expect(await watchCheckout(db!, s.id)).toBe('unchanged');
    expect((await stateOf(s.id))?.syncedHead).toBe(git(s.root, 'rev-parse', 'HEAD'));
    expect(await watchCheckout(db!, s.id)).toBe('unchanged');
  });
  it('imports another actual named branch but holds detached HEAD and a missing HEAD', async () => {
    enabled();
    const s = await fixture();
    git(s.root, 'checkout', '-qb', 'another');
    expect(await watchCheckout(db!, s.id)).toBe('synced');
    const before = await stateOf(s.id);
    git(s.root, 'checkout', '--detach', '-q');
    await disk(s.root, 'detached');
    expect(await watchCheckout(db!, s.id)).toBe('held');
    expect(await stateOf(s.id)).toEqual(before);
    expect((await repoOf(s.id)).renderContext).toMatchObject(context());
    git(s.root, 'symbolic-ref', 'HEAD', 'refs/heads/unborn');
    expect(await watchCheckout(db!, s.id)).toBe('held');
    expect(await stateOf(s.id)).toEqual(before);
  });
  it.each(['detach', 'merge', 'reset', 'upgrade', 'root-task'] as const)(
    'refuses %s arriving after the named-HEAD precheck without stamping or importing',
    async (kind) => {
      enabled();
      const s = await fixture();
      seam.afterPrecheck = async () => {
        if (kind === 'detach') git(s.root, 'checkout', '--detach', '-q');
        if (kind === 'merge')
          await writeFile(join(s.root, '.git/MERGE_HEAD'), git(s.root, 'rev-parse', 'HEAD'));
        if (kind === 'reset')
          await db!
            .update(schema.repositories)
            .set({ rootClaimedAt: new Date(), rootClaimKind: 'reset' })
            .where(eq(schema.repositories.id, s.id));
        if (kind === 'upgrade' || kind === 'root-task')
          await db!.insert(schema.tasks).values({
            userId: s.userId,
            repositoryId: s.id,
            title: 'holder',
            type: kind === 'upgrade' ? 'onboarding_upgrade' : 'workflow',
            status: 'running',
          });
      };
      expect(await watchCheckout(db!, s.id)).toBe('held');
      expect(await stateOf(s.id)).toBeUndefined();
      expect((await repoOf(s.id)).renderContext).toBeNull();
    },
  );
  it('retries a failed first import with no outbox, and never stamps unreadable, conflicting or unsupported records', async () => {
    enabled();
    const s = await fixture();
    const path = join(s.root, '.haive-data/state/project/render.json');
    for (const bad of ['<<<<<<< ours\n{}\n=======\n{}\n>>>>>>> theirs', '{bad json']) {
      await writeFile(path, bad);
      expect(await watchCheckout(db!, s.id)).toBe('refused');
      expect(await stateOf(s.id)).toBeUndefined();
    }
    await disk(s.root);
    await writeFile(join(s.root, '.haive-data/state/format.json'), '{"schemaVersion":999}\n');
    expect(await watchCheckout(db!, s.id)).toBe('refused');
    await disk(s.root);
    await rm(path);
    await symlink('/etc/hostname', path);
    expect(await watchCheckout(db!, s.id)).toBe('refused');
    expect(await stateOf(s.id)).toBeUndefined();
    await rm(path);
    await disk(s.root);
    expect(await watchCheckout(db!, s.id)).toBe('synced');
    const before = await stateOf(s.id);
    await rm(join(s.root, '.haive-data/state'), { recursive: true });
    expect(await watchCheckout(db!, s.id)).toBe('absent');
    expect(await stateOf(s.id)).toEqual(before);
  });
  it('preserves local pending changes and asks about a same-key change', async () => {
    enabled();
    const s = await fixture();
    await watchCheckout(db!, s.id);
    await db!
      .update(schema.repositories)
      .set({ renderContext: { ...context('local'), rtkChoiceRecorded: false } })
      .where(eq(schema.repositories.id, s.id));
    await markProjectStateDirty(db!, s.id);
    await disk(s.root, 'their');
    expect(await watchCheckout(db!, s.id)).toBe('synced');
    expect((await repoOf(s.id)).renderContext).toMatchObject(context('local'));
    expect(await readCheckout(s.root)).toMatchObject({ kind: 'record', render: context('their') });
    const rows = await db!
      .select()
      .from(schema.projectStateConflicts)
      .where(and(eq(schema.projectStateConflicts.repositoryId, s.id)));
    expect(rows.some((row) => row.unit.endsWith('#projectInfo') && row.resolvedAt === null)).toBe(
      true,
    );
  });
  it('scans repos without an outbox even after cancelled or dead tasks, and requeues beyond cancellation retry caps', async () => {
    enabled();
    const s = await fixture();
    const [task] = await db!
      .insert(schema.tasks)
      .values({
        userId: s.userId,
        repositoryId: s.id,
        title: 'cancelled',
        type: 'onboarding',
        status: 'cancelled',
      })
      .returning();
    await db!.insert(schema.taskEvents).values(
      Array.from({ length: 3 }, () => ({
        taskId: task!.id,
        eventType: 'task.cancel_redriven',
        payload: {},
      })),
    );
    const queued: string[] = [];
    await sweepCheckoutRepositories(db!, async (id) => {
      queued.push(id);
    });
    expect(queued).toContain(s.id);
    expect(await watchCheckout(db!, s.id)).toBe('synced');
    await db!
      .update(schema.tasks)
      .set({ status: 'running', deadAt: new Date() })
      .where(eq(schema.tasks.id, task!.id));
    await disk(s.root, 'dead-released');
    expect(await watchCheckout(db!, s.id)).toBe('synced');
  });

  it('refuses a nested directory without its own Git root, a linked .git and an outside gitfile', async () => {
    enabled();
    const s = await fixture();
    const child = join(s.root, 'child');
    await mkdir(child);
    await disk(child, 'child');
    await db!
      .update(schema.repositories)
      .set({ storagePath: child })
      .where(eq(schema.repositories.id, s.id));
    expect(await watchCheckout(db!, s.id)).toBe('held');
    await symlink(join(s.root, '.git'), join(child, '.git'));
    expect(await watchCheckout(db!, s.id)).toBe('held');
    await rm(join(child, '.git'));
    await writeFile(join(child, '.git'), `gitdir: ${join(s.root, '.git')}\n`);
    expect(await watchCheckout(db!, s.id)).toBe('held');
    expect(await stateOf(s.id)).toBeUndefined();
    expect((await repoOf(s.id)).renderContext).toBeNull();
  });
  it('reconciles hand-edited plan bytes on a state/HEAD no-op, and holds plan import when detached', async () => {
    enabled();
    const s = await fixture();
    const rootId = randomUUID();
    const plan = (title: string) => ({
      schemaVersion: 2,
      nodes: [
        {
          id: rootId,
          parentId: null,
          ordinal: 0,
          title,
          kind: 'component',
          body: null,
          status: 'todo',
          taskable: false,
        },
      ],
      edges: [],
      codeLinks: [],
    });
    const path = join(s.root, '.haive-data/plan.json');
    await writeFile(path, JSON.stringify(plan('First plan')));
    expect(await watchCheckout(db!, s.id)).toBe('synced');
    const before = await stateOf(s.id);
    await writeFile(path, JSON.stringify(plan('Edited plan')));
    expect(await watchCheckout(db!, s.id)).toBe('unchanged');
    expect(
      (await db!.select().from(schema.planNodes).where(eq(schema.planNodes.id, rootId)))[0]?.title,
    ).toBe('Edited plan');
    expect(await stateOf(s.id)).toEqual(before);
    git(s.root, 'checkout', '--detach', '-q');
    await writeFile(path, JSON.stringify(plan('Detached plan')));
    expect(await watchCheckout(db!, s.id)).toBe('held');
    expect(
      (await db!.select().from(schema.planNodes).where(eq(schema.planNodes.id, rootId)))[0]?.title,
    ).toBe('Edited plan');
  });
  it('recovers a pending record journal before importing, and holds an editor change outside both journal sides', async () => {
    enabled();
    const s = await fixture();
    await watchCheckout(db!, s.id);
    const path = join(s.root, '.haive-data/state/settings/rtk-version.json');
    const before = await readFile(path, 'utf8');
    const info = await stat(path);
    const planned = '"8.0.0"\n';
    await markProjectStateDirty(db!, s.id);
    const writeIntent = {
      id: randomUUID(),
      changes: [
        {
          rel: 'settings/rtk-version.json',
          before,
          after: planned,
          metadata: { uid: info.uid, gid: info.gid, mode: info.mode & 0o7777 },
        },
      ],
    };
    await db!
      .update(schema.projectStateOutbox)
      .set({ writeIntent })
      .where(eq(schema.projectStateOutbox.repositoryId, s.id));
    await writeFile(path, '"9.0.0"\n');
    const previous = await stateOf(s.id);
    expect(await watchCheckout(db!, s.id)).toBe('held');
    expect(await stateOf(s.id)).toEqual(previous);
    expect((await repoOf(s.id)).rtkVersion).toBe('1.0.0');
    await writeFile(path, planned);
    expect(await watchCheckout(db!, s.id)).toBe('synced');
    expect((await repoOf(s.id)).rtkVersion).toBe('1.0.0');
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(
      (
        await db!
          .select()
          .from(schema.projectStateOutbox)
          .where(eq(schema.projectStateOutbox.repositoryId, s.id))
      )[0]?.writeIntent,
    ).toBeNull();
  });
  it('rechecks a NULL watermark and preserves raw bytes separately from the normalized base', async () => {
    enabled();
    const s = await fixture();
    await watchCheckout(db!, s.id);
    await db!
      .update(schema.projectStateSync)
      .set({ syncedHash: null, syncedHead: null })
      .where(eq(schema.projectStateSync.repositoryId, s.id));
    const path = join(s.root, '.haive-data/state/project/render.json');
    await writeFile(path, JSON.stringify(context('formatted'), null, 4) + '\n');
    expect(await watchCheckout(db!, s.id)).toBe('synced');
    const read = await readCheckout(s.root);
    expect(read.kind).toBe('record');
    if (read.kind === 'record') expect((await stateOf(s.id))?.syncedHash).toBe(read.hash);
    expect((await stateOf(s.id))?.baseSnapshot).toMatchObject({ render: context('formatted') });
    expect(await watchCheckout(db!, s.id)).toBe('unchanged');
  });
  it('clears a refusal after restoring the exact previously accepted record', async () => {
    enabled();
    const s = await fixture();
    await watchCheckout(db!, s.id);
    const path = join(s.root, '.haive-data/state/project/render.json');
    const before = await readFile(path, 'utf8');
    const accepted = await stateOf(s.id);
    await writeFile(path, '{invalid');
    expect(await watchCheckout(db!, s.id)).toBe('refused');
    expect((await stateOf(s.id))?.lastError).toMatch(/not read/);
    expect((await stateOf(s.id))?.syncedHash).toBe(accepted?.syncedHash);
    await writeFile(path, before);
    await watchCheckout(db!, s.id);
    expect((await stateOf(s.id))?.lastError).toBeNull();
    expect((await stateOf(s.id))?.syncedHash).toBe(accepted?.syncedHash);
  });
  it('rolls back imported columns and watermarks if HEAD detaches after the column update', async () => {
    enabled();
    const s = await fixture();
    await watchCheckout(db!, s.id);
    const before = await stateOf(s.id);
    await disk(s.root, 'during-import');
    let moved = false;
    const guardedDb = new Proxy(db!, {
      get(target, key) {
        if (key === 'transaction')
          return (callback: Parameters<NonNullable<typeof db>['transaction']>[0]) =>
            target.transaction(async (tx) => {
              const guardedTx = new Proxy(tx, {
                get(inner, prop) {
                  if (prop === 'update')
                    return (table: Parameters<typeof tx.update>[0]) => ({
                      set(values: Record<string, unknown>) {
                        const query = tx.update(table).set(values as never);
                        if (
                          table !== schema.repositories ||
                          !Object.hasOwn(values, 'renderContext')
                        )
                          return query;
                        return {
                          where: async (condition: SQL | undefined) => {
                            const result = await query.where(condition);
                            if (!moved) {
                              git(s.root, 'checkout', '--detach', '-q');
                              moved = true;
                            }
                            return result;
                          },
                        };
                      },
                    });
                  const value = Reflect.get(inner, prop);
                  return typeof value === 'function' ? value.bind(inner) : value;
                },
              });
              return callback(guardedTx);
            });
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect(await watchCheckout(guardedDb, s.id)).toBe('held');
    expect(moved).toBe(true);
    expect((await repoOf(s.id)).renderContext).toMatchObject(context());
    expect(await stateOf(s.id)).toEqual(before);
  });
  it('stops observation with the switch while writer safety still imports unseen data', async () => {
    enabled();
    const s = await fixture();
    await watchCheckout(db!, s.id);
    await disk(s.root, 'unseen');
    vi.mocked(configService.getBoolean).mockResolvedValue(false);
    expect(await watchCheckout(db!, s.id)).toBe('disabled');
    expect(
      await sweepCheckoutRepositories(db!, async () => {
        throw new Error('must not enqueue');
      }),
    ).toBe(0);
    const repo = await repoOf(s.id);
    await expect(
      writeProjectStateColumn(db!, {
        repositoryId: s.id,
        repoPath: s.root,
        column: repo.renderContext as never,
      }),
    ).rejects.toThrow();
    expect((await repoOf(s.id)).renderContext).toMatchObject(context('unseen'));
    expect((await stateOf(s.id))?.syncedHead).toBeNull();
  });
});
