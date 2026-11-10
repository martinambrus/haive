import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb, type FakeDbHandle } from '@haive/database/testing';
import { logger } from '@haive/shared';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { gate4PushStep } from '../src/step-engine/steps/workflow/11a-gate-4-push.js';

const h = vi.hoisted(() => ({
  origin: null as string | null,
  trace: [] as string[],
  push: vi.fn(async () => {}),
  ensure: vi.fn(),
  git: vi.fn(),
  credential: vi.fn(async () => ({ argv: [], env: {}, secret: '' })),
}));
vi.mock('../src/repo/git-push.js', async (original) => ({
  ...(await original<typeof import('../src/repo/git-push.js')>()),
  getOriginUrl: vi.fn(async () => h.origin),
  buildCredentialHelper: h.credential,
  taskRemoteUrl: vi.fn(async () => h.origin),
  ensureOrigin: h.ensure,
  gitRun: h.git,
  pushBranch: h.push,
}));
const OWNER = '00000000-0000-4000-8000-000000000001';
const REPO = '00000000-0000-4000-8000-000000000003';
const CREDENTIAL = '00000000-0000-4000-8000-000000000005';
const URL = 'https://example.com/repo.git';
beforeEach(() => {
  vi.clearAllMocks();
  h.origin = null;
  h.trace = [];
  h.ensure.mockImplementation(
    async (_cwd: string, url: string, options?: { onAdded?: () => void }) => {
      h.trace.push('git add');
      h.origin = url;
      options?.onAdded?.();
      return { added: true, updated: false };
    },
  );
  h.git.mockImplementation(async (_cwd: string, args: string[]) => {
    h.trace.push(args.join(' '));
    if (args.join(' ') === 'remote remove origin') h.origin = null;
    return { code: 0, stdout: '', stderr: '' };
  });
});
function setup(remoteUrl: string | null = null, dropDuringGit = false, failRowLock = false) {
  let rejectTransaction: (err: Error) => void = () => {};
  const connectionFailure = dropDuringGit
    ? new Promise<never>((_resolve, reject) => {
        rejectTransaction = reject;
      })
    : null;
  const fake = createFakeDb({ repositories: schema.repositories, auditEvents: schema.auditEvents });
  fake.insert(schema.repositories, {
    id: REPO,
    userId: OWNER,
    remoteUrl,
    credentialsSecretId: null,
  });
  const traced = (tx: FakeDbHandle): FakeDbHandle =>
    new Proxy(tx, {
      get(target, prop) {
        if (prop === 'select')
          return (...args: Parameters<FakeDbHandle['select']>) => {
            const selection = target.select(...args);
            return {
              from: (table: Parameters<typeof selection.from>[0]) => {
                const query = selection.from(table);
                const take = query.for.bind(query);
                query.for = ((strength: Parameters<typeof take>[0]) => {
                  h.trace.push('lock ' + strength);
                  if (failRowLock) throw new Error('repository lock timeout');
                  return take(strength);
                }) as typeof query.for;
                return query;
              },
            };
          };
        if (prop === 'execute')
          return async (query: Parameters<FakeDbHandle['execute']>[0]) => {
            h.trace.push('execute');
            return target.execute(query);
          };
        return Reflect.get(target, prop);
      },
    });
  const db = new Proxy(fake.db, {
    get(target, prop) {
      if (prop === 'transaction')
        return (callback: (tx: FakeDbHandle) => Promise<unknown>) => {
          const running = target.transaction((tx) => callback(traced(tx)));
          return connectionFailure ? Promise.race([running, connectionFailure]) : running;
        };
      return Reflect.get(target, prop);
    },
  }) as unknown as Database;
  fake.hooks.beforeInsert = (table) => {
    if (table === schema.auditEvents) h.trace.push('audit');
  };
  fake.hooks.beforeUpdate = (table) => {
    if (table === schema.repositories) h.trace.push('row update');
  };
  fake.hooks.beforeCommit = () => {
    h.trace.push('commit');
  };
  const apply = (hasOrigin = false, remote = URL, credentialId = CREDENTIAL) =>
    gate4PushStep.apply(
      {
        db,
        userId: OWNER,
        logger,
      } as unknown as StepContext,
      {
        iteration: 0,
        previousIterations: [],
        detected: {
          hasGit: true,
          workspacePath: '/unused',
          branch: 'main',
          hasOrigin,
          originUrl: h.origin,
          recentCommits: '',
          repositoryId: REPO,
          boundCredentialId: null,
          credentials: [],
        },
        formValues: { push: true, remoteUrl: remote, credentialId },
      },
    );
  return {
    fake,
    apply,
    dropConnection: () => rejectTransaction(new Error('connection lost')),
    repo: () => fake.rows(schema.repositories)[0]!,
    audits: () => fake.rows(schema.auditEvents),
  };
}

describe('T505.1 transactional gate-4 remote', () => {
  it('locks, audits changed fields without values, changes git, writes row, and commits before push', async () => {
    const s = setup();
    h.push.mockImplementationOnce(async () => {
      expect(h.trace.at(-1)).toBe('commit');
    });
    await s.apply();
    expect(s.repo()).toMatchObject({ remoteUrl: URL, credentialsSecretId: CREDENTIAL });
    expect(s.audits()).toEqual([
      expect.objectContaining({
        actorUserId: OWNER,
        targetType: 'repository',
        targetId: REPO,
        action: 'repository.remote.update',
        metadata: {
          source: 'gate4_push',
          actorKind: 'task_user',
          fields: ['remoteUrl', 'credentialsSecretId'],
        },
      }),
    ]);
    const order = h.trace.filter((v) => v !== 'execute');
    expect(order).toEqual(['lock no key update', 'audit', 'git add', 'row update', 'commit']);
  });
  it.each(['audit', 'row', 'commit'])(
    'refused %s leaves no audit or row change and restores git',
    async (failure) => {
      const s = setup();
      if (failure === 'audit')
        s.fake.hooks.beforeInsert = (table) => {
          if (table === schema.auditEvents) throw new Error('audit refused');
        };
      if (failure === 'row')
        s.fake.hooks.beforeUpdate = () => {
          throw new Error('row refused');
        };
      if (failure === 'commit')
        s.fake.hooks.beforeCommit = () => {
          throw new Error('commit refused');
        };
      await expect(s.apply()).rejects.toThrow('refused');
      expect(s.repo()).toMatchObject({ remoteUrl: null, credentialsSecretId: null });
      expect(s.audits()).toEqual([]);
      expect(h.origin).toBeNull();
      expect(h.ensure).toHaveBeenCalledTimes(failure === 'audit' ? 0 : 1);
      expect(h.git).toHaveBeenCalledTimes(failure === 'audit' ? 0 : 1);
      expect(h.push).not.toHaveBeenCalled();
    },
  );
  it('restores an add that reports failure after changing git, before releasing the row', async () => {
    const s = setup();
    h.ensure.mockImplementationOnce(async (_cwd, url, options) => {
      h.origin = url;
      options.onAdded();
      throw new Error('git add refused after mutation');
    });
    s.fake.hooks.beforeCommit = () => {
      throw new Error('must not commit');
    };
    await expect(s.apply()).rejects.toThrow('git add refused');
    expect(h.origin).toBeNull();
    expect(s.audits()).toEqual([]);
    expect(h.git).toHaveBeenCalledTimes(1);
  });
  it('reports a restore failure even when the transaction fails too', async () => {
    const s = setup();
    s.fake.hooks.beforeUpdate = () => {
      throw new Error('row refused');
    };
    h.git.mockResolvedValueOnce({ code: 1, stdout: '', stderr: '' });
    await expect(s.apply()).rejects.toThrow('added origin could not be removed');
    expect(s.audits()).toEqual([]);
    expect(s.repo().remoteUrl).toBeNull();
    expect(h.git).toHaveBeenCalledTimes(1);
  });
  it('waits for a live git callback after a connection failure and restores exactly once', async () => {
    const s = setup(null, true);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.ensure.mockImplementationOnce(async (_cwd, url, options) => {
      enter();
      await released;
      h.origin = url;
      options.onAdded();
    });
    s.fake.hooks.beforeUpdate = () => {
      throw new Error('connection lost');
    };
    const pending = s.apply();
    let settled = false;
    void pending.catch(() => {
      settled = true;
    });
    await entered;
    s.dropConnection();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect(h.git).not.toHaveBeenCalled();
    release();
    await expect(pending).rejects.toThrow('connection lost');
    expect(h.origin).toBeNull();
    expect(h.git).toHaveBeenCalledTimes(1);
    expect(s.audits()).toEqual([]);
  });
  it('a failed row take reaches neither audit nor git', async () => {
    const s = setup(null, false, true);
    await expect(s.apply()).rejects.toThrow('repository lock timeout');
    expect(s.audits()).toEqual([]);
    expect(h.ensure).not.toHaveBeenCalled();
    expect(h.git).not.toHaveBeenCalled();
  });
  it('adding git origin to an already-matching row emits no setting audit', async () => {
    const s = setup(URL);
    s.fake.patch(schema.repositories, REPO, { credentialsSecretId: CREDENTIAL });
    await s.apply();
    expect(s.audits()).toEqual([]);
    expect(h.origin).toBe(URL);
  });
  it('strips credentials from a supplied URL before git and persistence', async () => {
    const s = setup();
    await s.apply(false, 'https://user:secret@example.com/repo.git');
    expect(s.repo().remoteUrl).toBe(URL);
    expect(h.origin).toBe(URL);
    expect(JSON.stringify(s.audits())).not.toContain('secret');
  });
});
