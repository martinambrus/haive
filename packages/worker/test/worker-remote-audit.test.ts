import { safeErrorMessage } from '@haive/shared/logger';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb, type FakeDbHandle } from '@haive/database/testing';
import { logger, validateFormValues } from '@haive/shared';
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
function setup(
  remoteUrl: string | null = null,
  dropDuringGit = false,
  failRowLock: boolean | Error = false,
  beforeRowLock?: () => void,
) {
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
                  beforeRowLock?.();
                  if (failRowLock)
                    throw failRowLock instanceof Error
                      ? failRowLock
                      : new Error('repository lock timeout');
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
  const apply = (
    hasOrigin = false,
    remote = URL,
    credentialId = CREDENTIAL,
    detectedOrigin = h.origin,
    overrides: {
      formValues?: Record<string, unknown>;
      detected?: Partial<Parameters<typeof gate4PushStep.apply>[1]['detected']>;
    } = {},
  ) =>
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
          originUrl: detectedOrigin,
          recentCommits: '',
          repositoryId: REPO,
          boundCredentialId: null,
          credentials: [],
          ...overrides.detected,
        },
        formValues: overrides.formValues ?? { push: true, remoteUrl: remote, credentialId },
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
          host: 'example.com',
          credentialsChanged: true,
          branchChanged: false,
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
  it.each([false, true])(
    'maps a lock timeout (wrapped: %s) before audit or git',
    async (wrapped) => {
      const pg = Object.assign(new Error('driver lock detail'), { code: '55P03' });
      const error = wrapped
        ? Object.assign(new Error('query detail', { cause: pg }), { params: ['bound value'] })
        : pg;
      const s = setup(null, false, error);
      const failure = await s.apply().then(
        () => null,
        (err: unknown) => err,
      );
      expect(safeErrorMessage(failure)).toBe('Repository is busy. Retry this step in a moment.');
      expect(s.repo().remoteUrl).toBeNull();
      expect(s.audits()).toEqual([]);
      expect(h.ensure).not.toHaveBeenCalled();
      expect(h.push).not.toHaveBeenCalled();
    },
  );
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
describe('T505.2 Retry with a checkout origin and empty repository remote', () => {
  it('repairs a row after a failed update followed by Retry, without replacing the surviving origin', async () => {
    const s = setup();
    s.fake.hooks.beforeUpdate = () => {
      throw new Error('row refused');
    };
    await expect(s.apply()).rejects.toThrow('row refused');
    // The old implementation left this origin after its failed row update.
    h.origin = URL;
    s.fake.hooks.beforeUpdate = null;
    await s.apply(true);
    expect(s.repo()).toMatchObject({ remoteUrl: URL, credentialsSecretId: CREDENTIAL });
    expect(s.audits()).toHaveLength(1);
  });
  it('does not rebind a stored remote or credential for a one-off push', async () => {
    const s = setup(URL);
    h.origin = URL;
    await s.apply(true);
    expect(s.repo()).toMatchObject({ remoteUrl: URL, credentialsSecretId: null });
    expect(s.audits()).toEqual([]);
    expect(h.ensure).not.toHaveBeenCalled();
  });
  it.each(['audit', 'commit'])(
    'Retry repair keeps the existing origin when %s fails',
    async (failure) => {
      const s = setup();
      h.origin = URL;
      if (failure === 'audit')
        s.fake.hooks.beforeInsert = (table) => {
          if (table === schema.auditEvents) throw new Error('audit refused');
        };
      else
        s.fake.hooks.beforeCommit = () => {
          throw new Error('commit refused');
        };
      await expect(s.apply(true)).rejects.toThrow('refused');
      expect(s.repo().remoteUrl).toBeNull();
      expect(s.audits()).toEqual([]);
      expect(h.origin).toBe(URL);
      expect(h.ensure).not.toHaveBeenCalled();
      expect(h.git).not.toHaveBeenCalled();
      expect(h.push).not.toHaveBeenCalled();
    },
  );
  it('uses the checkout origin rather than a stale form value, and audits only changed fields once', async () => {
    const s = setup();
    h.origin = URL;
    await s.apply(true, 'https://stale.example/repo.git', '');
    await s.apply(true, 'https://stale.example/repo.git', '');
    expect(s.repo()).toMatchObject({ remoteUrl: URL, credentialsSecretId: null });
    expect(s.audits()).toEqual([
      expect.objectContaining({
        metadata: {
          source: 'gate4_push',
          actorKind: 'task_user',
          fields: ['remoteUrl'],
          host: 'example.com',
          credentialsChanged: false,
          branchChanged: false,
        },
      }),
    ]);
    expect(h.ensure).not.toHaveBeenCalled();
  });
  it('never persists credentials from an existing origin', async () => {
    const s = setup();
    h.origin = 'https://user:secret@example.com/repo.git';
    await s.apply(true);
    expect(s.repo().remoteUrl).toBe(URL);
    expect(JSON.stringify(s.audits())).not.toContain('secret');
  });
});

describe('Fix-1 approval and lock controls', () => {
  it('refuses an origin changed after the form without persisting or using credentials', async () => {
    const s = setup();
    h.origin = 'https://changed.example/repo.git';
    await expect(s.apply(true, URL, CREDENTIAL, URL)).rejects.toThrow(
      /origin changed since the form.*retry/i,
    );
    expect(s.repo()).toMatchObject({ remoteUrl: null, credentialsSecretId: null });
    expect(s.audits()).toEqual([]);
    expect(h.credential).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
  });
  it('a bound row with an origin pushes without a row lock', async () => {
    const s = setup(URL, false, true);
    h.origin = URL;
    await s.apply(true);
    expect(h.trace).not.toContain('lock no key update');
    expect(s.audits()).toEqual([]);
    expect(h.push).toHaveBeenCalledOnce();
  });
  it('remote metadata has the API host and change flags without remote or credential values', async () => {
    const s = setup();
    await s.apply(false, 'git@example.com:owner/repo.git');
    expect(s.audits()[0]?.metadata).toEqual({
      source: 'gate4_push',
      actorKind: 'task_user',
      fields: ['remoteUrl', 'credentialsSecretId'],
      host: 'example.com',
      credentialsChanged: true,
      branchChanged: false,
    });
  });
});

describe('gate 4 preserves saved repository settings', () => {
  function expectNoPushOrWrite(s: ReturnType<typeof setup>, before: unknown) {
    expect(s.repo()).toEqual(before);
    expect(s.audits()).toEqual([]);
    expect(h.origin).toBeNull();
    expect(h.ensure).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
    expect(h.credential).not.toHaveBeenCalled();
    expect(h.trace).not.toContain('row update');
    expect(h.trace).toContain('lock no key update');
  }

  it('refuses a typed URL over a saved remote without changing git or repository state', async () => {
    const s = setup('https://saved.example/repo.git');
    const before = { ...s.repo() };
    const result = await s.apply();
    expect(result).toMatchObject({
      pushed: false,
      message: expect.stringContaining('Change remote on the [Repositories page](/repos)'),
    });
    expectNoPushOrWrite(s, before);
  });

  it('refuses a chosen credential over a saved credential, including when the remote slot is empty', async () => {
    const s = setup();
    s.fake.patch(schema.repositories, REPO, { credentialsSecretId: 'saved-credential' });
    const before = { ...s.repo() };
    const result = await s.apply();
    expect(result).toMatchObject({
      pushed: false,
      message: expect.stringContaining('Change remote on the [Repositories page](/repos)'),
    });
    expectNoPushOrWrite(s, before);
  });

  it.each(['remoteUrl', 'credentialsSecretId'] as const)(
    'fills only the empty %s slot when the other saved value matches',
    async (emptySlot) => {
      const s = setup(emptySlot === 'remoteUrl' ? null : URL);
      if (emptySlot === 'remoteUrl')
        s.fake.patch(schema.repositories, REPO, { credentialsSecretId: CREDENTIAL });
      expect(await s.apply()).toMatchObject({ pushed: true });
      expect(s.repo()).toMatchObject({ remoteUrl: URL, credentialsSecretId: CREDENTIAL });
      expect(s.audits()).toHaveLength(1);
      expect(s.audits()[0]?.metadata).toMatchObject({ fields: [emptySlot] });
      expect(h.push).toHaveBeenCalledOnce();
    },
  );

  it.each(['remoteUrl', 'credentialsSecretId'] as const)(
    'rejects a replacement accepted by an old parked form when %s changes after the initial read',
    async (field) => {
      const legacySchema = {
        title: 'Gate 4: Push',
        fields: [
          { type: 'checkbox' as const, id: 'push', label: 'Push' },
          { type: 'text' as const, id: 'remoteUrl', label: 'Remote URL', required: true },
          {
            type: 'select' as const,
            id: 'credentialId',
            label: 'Credential',
            options: [{ value: CREDENTIAL, label: 'Chosen' }],
          },
        ],
      };
      expect(
        validateFormValues(legacySchema, { push: true, remoteUrl: URL, credentialId: CREDENTIAL })
          .success,
      ).toBe(true);
      const saved = {
        [field]: field === 'remoteUrl' ? 'https://saved.example/repo.git' : 'saved-credential',
      };
      const s = setup(null, false, false, () => s.fake.patch(schema.repositories, REPO, saved));
      const before = { ...s.repo(), ...saved };
      expect(await s.apply()).toMatchObject({
        pushed: false,
        message: expect.stringContaining('Change remote on the [Repositories page](/repos)'),
      });
      expectNoPushOrWrite(s, before);
    },
  );
});

describe('gate 4 saved-value submissions', () => {
  it('uses the saved values displayed as notes when the form submits only push', async () => {
    const s = setup(URL);
    s.fake.patch(schema.repositories, REPO, { credentialsSecretId: CREDENTIAL });
    const result = await s.apply(false, URL, CREDENTIAL, null, {
      formValues: { push: true },
      detected: { savedRemoteUrl: URL, boundCredentialId: CREDENTIAL },
    });
    expect(result.pushed).toBe(true);
    expect(h.origin).toBe(URL);
    expect(h.push).toHaveBeenCalledWith(expect.objectContaining({ credentialId: CREDENTIAL }));
    expect(s.audits()).toEqual([]);
  });

  it('does not replace a saved credential while repairing an empty remote slot with an existing origin', async () => {
    const s = setup();
    s.fake.patch(schema.repositories, REPO, { credentialsSecretId: 'saved-credential' });
    h.origin = URL;
    const before = { ...s.repo() };
    expect(await s.apply(true)).toMatchObject({
      pushed: false,
      message: expect.stringContaining('Change remote on the [Repositories page](/repos)'),
    });
    expect(s.repo()).toEqual(before);
    expect(s.audits()).toEqual([]);
    expect(h.ensure).not.toHaveBeenCalled();
    expect(h.credential).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
  });
});

describe('gate 4 snapshot fallbacks never refill cleared slots', () => {
  it.each([
    { field: 'remoteUrl', hasOrigin: false, clearAtLock: false },
    { field: 'remoteUrl', hasOrigin: false, clearAtLock: true },
    { field: 'credentialsSecretId', hasOrigin: false, clearAtLock: false },
    { field: 'credentialsSecretId', hasOrigin: false, clearAtLock: true },
    { field: 'credentialsSecretId', hasOrigin: true, clearAtLock: false },
    { field: 'credentialsSecretId', hasOrigin: true, clearAtLock: true },
  ] as const)(
    'refuses snapshot $field cleared after detect (hasOrigin=$hasOrigin, clearAtLock=$clearAtLock)',
    async ({ field, hasOrigin, clearAtLock }) => {
      const clear = () => s.fake.patch(schema.repositories, REPO, { [field]: null });
      const s = setup(hasOrigin ? null : URL, false, false, clearAtLock ? clear : undefined);
      s.fake.patch(schema.repositories, REPO, { credentialsSecretId: CREDENTIAL });
      if (hasOrigin) h.origin = URL;
      if (!clearAtLock) clear();
      const before = { ...s.repo(), [field]: null };
      const detected = {
        hasGit: true,
        workspacePath: '/unused',
        branch: 'main',
        hasOrigin,
        originUrl: h.origin,
        recentCommits: '',
        repositoryId: REPO,
        savedRemoteUrl: hasOrigin ? null : URL,
        boundCredentialId: CREDENTIAL,
        credentials: [{ id: CREDENTIAL, label: 'Saved token', host: 'example.com' }],
      };
      const form = gate4PushStep.form!({} as StepContext, detected, undefined)!;
      const submitted = validateFormValues(form, { push: true });
      expect(submitted.success).toBe(true);
      if (!submitted.success) throw new Error('Expected the note-only form to validate');
      const result = await s.apply(hasOrigin, URL, CREDENTIAL, h.origin, {
        formValues: submitted.data,
        detected,
      });
      expect(result).toMatchObject({ pushed: false });
      expect(s.repo()).toEqual(before);
      expect(s.audits()).toEqual([]);
      expect(h.ensure).not.toHaveBeenCalled();
      expect(h.push).not.toHaveBeenCalled();
      expect(h.credential).not.toHaveBeenCalled();
      expect(h.trace).toContain('lock no key update');
      expect(h.trace).not.toContain('row update');
    },
  );
});

it('still fills cleared slots with explicitly submitted values from an old parked form', async () => {
  const s = setup();
  const result = await s.apply(false, URL, CREDENTIAL, null, {
    detected: { savedRemoteUrl: URL, boundCredentialId: CREDENTIAL },
    formValues: { push: true, remoteUrl: URL, credentialId: CREDENTIAL },
  });
  expect(result.pushed).toBe(true);
  expect(s.repo()).toMatchObject({ remoteUrl: URL, credentialsSecretId: CREDENTIAL });
  expect(s.audits()).toHaveLength(1);
  expect(h.push).toHaveBeenCalledOnce();
});
