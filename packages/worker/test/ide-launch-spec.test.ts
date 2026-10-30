import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  CODE_SERVER_IMAGE,
  IDE_IDLE_GRACE_MS,
  RUNNER_SUBPATH_LABEL,
  ideRunnerName,
  ideSessionKey,
  repoIdeSessionId,
} from '@haive/shared';

interface FakeContainer {
  running: boolean;
  labels: Record<string, string>;
}

// A stateful fake docker and a Map-backed fake Redis write ONE ordered call log, so a test can say
// what happened in which order. An `rm` is logged only when it removes a container that exists
// (`rm -f` of a missing name does nothing); every Redis call is logged.
const h = vi.hoisted(() => {
  const state = {
    containers: new Map<string, FakeContainer>(),
    registry: new Map<string, Record<string, string>>(),
    calls: [] as string[],
    runs: [] as string[][],
    registryRejects: false,
    runFails: false,
    unreadableLabel: null as string | null,
  };
  const out = (stdout: string) => ({ stdout, stderr: '' });
  const docker = async (_command: string, args: string[]) => {
    const [verb, ...rest] = args;
    if (verb === 'inspect') {
      const name = rest[rest.length - 1]!;
      const container = state.containers.get(name);
      if (!container) throw new Error(`Error: No such object: ${name}`);
      if (rest[0] !== '-f') return out('[{}]');
      const format = rest[1]!;
      if (format === '{{.State.Running}}') return out(`${container.running}\n`);
      const label = /^\{\{index \.Config\.Labels "(.+)"\}\}$/.exec(format)?.[1];
      if (label === undefined) throw new Error(`fake docker: unhandled inspect format ${format}`);
      if (label === state.unreadableLabel) throw new Error('docker inspect timed out');
      return out(`${container.labels[label] ?? ''}\n`);
    }
    if (verb === 'rm') {
      for (const name of rest.filter((arg) => !arg.startsWith('-'))) {
        if (state.containers.delete(name)) state.calls.push(`rm ${name}`);
      }
      return out('');
    }
    if (verb === 'run' && rest[0] === '-d') {
      const labels: Record<string, string> = {};
      let name = '';
      rest.forEach((arg, index) => {
        if (rest[index - 1] === '--name') name = arg;
        if (rest[index - 1] === '--label') {
          labels[arg.slice(0, arg.indexOf('='))] = arg.slice(arg.indexOf('=') + 1);
        }
      });
      state.containers.set(name, { running: true, labels });
      state.calls.push(`run ${name}`);
      state.runs.push(args);
      // The container exists by now: a docker that times out after creating it.
      if (state.runFails) throw new Error('docker run timed out');
      return out('container-id\n');
    }
    return out('{"status":"alive"}');
  };
  const redis = {
    hgetall: async (key: string) => {
      state.calls.push(`hgetall ${key}`);
      if (state.registryRejects) throw new Error('redis is down');
      return { ...state.registry.get(key) };
    },
    hset: async (key: string, field: string, value: string) => {
      state.calls.push(`hset ${key}`);
      state.registry.set(key, { ...state.registry.get(key), [field]: value });
      return 1;
    },
    del: async (key: string) => {
      state.calls.push(`del ${key}`);
      return state.registry.delete(key) ? 1 : 0;
    },
  };
  return { state, docker, redis };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: h.docker }) };
});
vi.mock('../src/redis.js', () => ({ getRedis: () => h.redis, getBullRedis: vi.fn() }));
vi.mock('../src/sandbox/sandbox-core-image.js', () => ({ ensureSandboxCoreImage: async () => {} }));
vi.mock('../src/queues/cli-exec/gitfile-mask.js', () => ({
  repoGitDataBoundary: async () => ({ mounts: [] }),
}));
vi.mock('../src/sandbox/docker-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/docker-runner.js')>()),
  defaultDockerRunner: {
    volumeExists: async () => true,
    run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  },
}));

import { ensureIdeRunnerStarted, ensureRepoIdeRunnerStarted } from '../src/sandbox/ide-runner.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000c1';
const SUBPATH = `${USER}/${REPO}`;
const SPEC_LABEL = 'haive.ide.spec';
const OLDER_IMAGE = 'codercom/code-server:4.0.0';

const fake = createFakeDb({
  repositories: schema.repositories,
  tasks: schema.tasks,
  taskSteps: schema.taskSteps,
});
fake.insert(schema.repositories, {
  id: REPO,
  userId: USER,
  source: 'git_url',
  status: 'ready',
  storagePath: `/var/lib/haive/repos/${SUBPATH}`,
});
fake.insert(schema.tasks, { id: TASK, userId: USER, repositoryId: REPO, type: 'workflow' });
const db = fake.db as unknown as Database;

interface Editor {
  /** The session id: the task id, or `repo-<id>` for a repository editor. */
  session: string;
  ensure: () => Promise<{ container: string } | null>;
}
const repositoryEditor: Editor = {
  session: repoIdeSessionId(REPO),
  ensure: () => ensureRepoIdeRunnerStarted(db, REPO, USER, '{}'),
};
const taskEditor: Editor = {
  session: TASK,
  ensure: () => ensureIdeRunnerStarted(db, TASK, USER, '{}'),
};

/** What follows the image in a `docker run` argv: the code-server flags the container runs with. */
const specOf = (args: string[]) => args.slice(args.indexOf(CODE_SERVER_IMAGE)).join(' ');

// The spec the code under test launches with today, read off a fresh boot's own argv, so no
// flag list is repeated here.
let SPEC = '';
beforeAll(async () => {
  await repositoryEditor.ensure();
  const args = h.state.runs[0]!;
  expect(args.indexOf(CODE_SERVER_IMAGE)).toBeGreaterThan(-1);
  SPEC = specOf(args);
});

beforeEach(() => {
  h.state.containers.clear();
  h.state.registry.clear();
  h.state.calls.length = 0;
  h.state.runs.length = 0;
  h.state.registryRejects = false;
  h.state.runFails = false;
  h.state.unreadableLabel = null;
});

/** A running container for the editor, mounting the right workspace unless `labels` say otherwise. */
const seed = (editor: Editor, labels: Record<string, string>) =>
  h.state.containers.set(ideRunnerName(editor.session), {
    running: true,
    labels: { [RUNNER_SUBPATH_LABEL]: SUBPATH, ...labels },
  });

/** Everything that changed state: container removals and launches, registry deletions. */
const mutations = () => h.state.calls.filter((call) => !call.startsWith('hgetall '));

const differing = (spec: string): Record<string, string> => {
  expect(spec).not.toBe(SPEC);
  return { [SPEC_LABEL]: spec };
};
const staleLaunches: [string, () => Record<string, string>][] = [
  ['no spec label', () => ({})],
  [
    'a spec label naming an older image',
    () => differing(SPEC.replace(CODE_SERVER_IMAGE, OLDER_IMAGE)),
  ],
  ['the current image with other flags', () => differing(SPEC.replace(' --disable-proxy', ''))],
];

const pastGrace = () => String(Date.now() - IDE_IDLE_GRACE_MS - 1000);
const idleRegistries: [string, (key: string) => void][] = [
  ['no registry hash', () => {}],
  [
    'refcount 0 and lastSeenAt past the grace',
    (key) => h.state.registry.set(key, { refcount: '0', lastSeenAt: pastGrace() }),
  ],
];
const heldRegistries: [string, (key: string) => void][] = [
  [
    'refcount 1 and lastSeenAt past the grace',
    (key) => h.state.registry.set(key, { refcount: '1', lastSeenAt: pastGrace() }),
  ],
  [
    'refcount 0 and lastSeenAt 60 s ago',
    (key) => h.state.registry.set(key, { refcount: '0', lastSeenAt: String(Date.now() - 60_000) }),
  ],
  [
    'a registry Redis cannot read',
    () => {
      h.state.registryRejects = true;
    },
  ],
];

describe.each(staleLaunches)('a running editor with %s', (_launch, labels) => {
  const { session, ensure } = repositoryEditor;
  const key = ideSessionKey(session);
  const name = ideRunnerName(session);

  it.each(idleRegistries)('is replaced once idle: %s', async (_registry, arrange) => {
    seed(repositoryEditor, labels());
    arrange(key);
    const before = Date.now();

    expect(await ensure()).toEqual({ container: name });

    // One removal, then one launch, with the session registered (never deleted) before the launch.
    expect(mutations()).toEqual([`rm ${name}`, `hset ${key}`, `run ${name}`]);
    expect(h.state.containers.get(name)?.labels[SPEC_LABEL]).toBe(SPEC);
    expect(Number(h.state.registry.get(key)?.lastSeenAt)).toBeGreaterThanOrEqual(before);
  });

  it.each(heldRegistries)('is kept while in use: %s', async (_registry, arrange) => {
    const launched = labels();
    seed(repositoryEditor, launched);
    arrange(key);

    expect(await ensure()).toEqual({ container: name });

    expect(mutations()).toEqual([]);
    expect(h.state.containers.get(name)?.labels).toEqual({
      [RUNNER_SUBPATH_LABEL]: SUBPATH,
      ...launched,
    });
  });
});

describe('an editor launched with the current spec', () => {
  it('is reused without removing, launching, writing or reading the registry', async () => {
    const { session, ensure } = repositoryEditor;
    const key = ideSessionKey(session);
    await ensure();
    // An idle entry, which would allow a replacement if anything consulted it.
    h.state.registry.set(key, { refcount: '0', lastSeenAt: pastGrace() });
    h.state.calls.length = 0;

    expect(await ensure()).toEqual({ container: ideRunnerName(session) });

    expect(h.state.calls).toEqual([]);
  });
});

describe('a running editor whose launch spec cannot be read', () => {
  it('is kept: what cannot be read is not called stale', async () => {
    const { session, ensure } = repositoryEditor;
    seed(repositoryEditor, {});
    h.state.unreadableLabel = SPEC_LABEL;

    expect(await ensure()).toEqual({ container: ideRunnerName(session) });

    expect(mutations()).toEqual([]);
  });
});

describe('a fresh editor boot', () => {
  it('stamps the image and flags it launched with', async () => {
    await repositoryEditor.ensure();
    const args = h.state.runs[0]!;
    expect(args.indexOf(CODE_SERVER_IMAGE)).toBeGreaterThan(-1);
    const labels = args.filter((_arg, index) => args[index - 1] === '--label');
    expect(labels).toContain(`${SPEC_LABEL}=${specOf(args)}`);
  });

  it('registers the session before the launch, over an entry an earlier container left idle', async () => {
    const { session, ensure } = repositoryEditor;
    const key = ideSessionKey(session);
    h.state.registry.set(key, { refcount: '0', lastSeenAt: pastGrace() });
    const before = Date.now();

    await ensure();

    expect(mutations()).toEqual([`hset ${key}`, `run ${ideRunnerName(session)}`]);
    expect(Number(h.state.registry.get(key)?.lastSeenAt)).toBeGreaterThanOrEqual(before);
  });

  it('leaves the session registered when the launch fails after the container exists', async () => {
    const { session, ensure } = repositoryEditor;
    h.state.runFails = true;

    await expect(ensure()).rejects.toThrow('docker run timed out');

    expect(h.state.registry.has(ideSessionKey(session))).toBe(true);
  });
});

describe('an editor holding another workspace', () => {
  it.each([
    ['the current spec', () => ({ [SPEC_LABEL]: SPEC })],
    ['no spec label', () => ({})],
  ])('is still recreated while in use, launched with %s', async (_launch, labels) => {
    const { session, ensure } = repositoryEditor;
    const key = ideSessionKey(session);
    const name = ideRunnerName(session);
    seed(repositoryEditor, { ...labels(), [RUNNER_SUBPATH_LABEL]: `${USER}/another-repository` });
    h.state.registry.set(key, { refcount: '1', lastSeenAt: String(Date.now()) });

    expect(await ensure()).toEqual({ container: name });

    expect(mutations()).toEqual([`rm ${name}`, `hset ${key}`, `run ${name}`]);
    expect(h.state.registry.get(key)?.refcount).toBe('1');
  });
});

describe('a task editor', () => {
  it('is replaced once idle when it was launched with another image or flags', async () => {
    const { session, ensure } = taskEditor;
    const key = ideSessionKey(session);
    const name = ideRunnerName(session);
    seed(taskEditor, {});
    h.state.registry.set(key, { refcount: '0', lastSeenAt: pastGrace() });

    expect(await ensure()).toEqual({ container: name });

    expect(mutations()).toEqual([`rm ${name}`, `hset ${key}`, `run ${name}`]);
    expect(h.state.containers.get(name)?.labels).toMatchObject({
      [SPEC_LABEL]: SPEC,
      'haive.task.id': TASK,
    });
  });
});
