import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import {
  APP_RUNNER_LABEL,
  IDE_RUNNER_LABEL,
  INSTALL_LABEL,
  configService,
  ideRunnerName,
  installId,
  repoIdeSessionId,
} from '@haive/shared';

interface Container {
  running: boolean;
  labels: Record<string, string>;
}

const h = vi.hoisted(() => ({
  containers: new Map<string, Container>(),
  calls: [] as string[][],
  task: undefined as Record<string, unknown> | undefined,
  repository: undefined as Record<string, unknown> | undefined,
  findTask: vi.fn(),
  info: vi.fn(),
}));

vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  logger: { child: () => ({ info: h.info, warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) },
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const run = async (_command: string, args: string[]) => {
    h.calls.push(args);
    const out = (stdout = '') => ({ stdout, stderr: '' });
    if (args[0] === 'ps') {
      const filters = args.filter((_, i) => args[i - 1] === '--filter');
      const rows = [...h.containers].filter(([, c]) =>
        filters.every((f) => {
          if (!f.startsWith('label=')) throw new Error(`Unexpected filter: ${f}`);
          const [key, value] = f.slice(6).split('=');
          return key! in c.labels && (value === undefined || c.labels[key!] === value);
        }),
      );
      const format = args[args.indexOf('--format') + 1];
      if (!args.includes('--format')) return out(rows.map(([id]) => id).join('\n'));
      return out(
        rows
          .map(([id, c]) =>
            format!
              .replaceAll('{{.ID}}', id)
              .replaceAll('{{.Names}}', id)
              .replace(/\{\{\.Label "([^"]+)"\}\}/g, (_, key: string) => c.labels[key] ?? ''),
          )
          .join('\n'),
      );
    }
    if (args[0] === 'inspect') {
      const c = h.containers.get(args.at(-1)!);
      if (!c) throw new Error('No such container');
      if (args[1] !== '-f') return out('[{}]');
      return out(
        args[2]!
          .replaceAll('{{.State.Running}}', String(c.running))
          .replaceAll('{{.State.StartedAt}}', '2026-01-01T00:00:00Z')
          .replace(
            /\{\{index \.Config.Labels "([^"]+)"\}\}/g,
            (_, key: string) => c.labels[key] ?? '<no value>',
          ),
      );
    }
    if (args[0] === 'rm') {
      for (const id of args.slice(1).filter((x) => !x.startsWith('-'))) h.containers.delete(id);
      return out();
    }
    if (args[0] === 'run') {
      const labels: Record<string, string> = {};
      args.forEach((arg, i) => {
        if (args[i - 1] !== '--label') return;
        const split = arg.indexOf('=');
        labels[arg.slice(0, split)] = arg.slice(split + 1);
      });
      h.containers.set(args[args.indexOf('--name') + 1]!, { running: true, labels });
      return out('created-id');
    }
    if (['image', 'exec', 'cp', 'network', 'stop'].includes(args[0]!)) return out();
    throw new Error(`Unexpected docker call: ${args.join(' ')}`);
  };
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: run }) };
});
vi.mock('../db.js', () => ({
  getDb: () => ({
    query: {
      tasks: { findFirst: h.findTask },
      repositories: { findFirst: async () => h.repository },
      taskDatabaseStates: { findFirst: async () => undefined },
    },
  }),
}));
vi.mock('./runtime-caps.js', () => ({
  RUNTIME_WEIGHT_LABEL: 'haive.runtime.weight',
  resolveRunnerCaps: async () => null,
  buildResourceLimitArgs: () => [],
}));
vi.mock('./runner-activity.js', () => ({
  runnerExecLive: async () => false,
  taskRunnerBusy: () => false,
  whileRunnerBusy: async (_name: string, fn: () => Promise<unknown>) => fn(),
  withRunnersFenced: async (_task: string, fn: (idle: () => boolean) => Promise<unknown>) =>
    fn(() => true),
}));
vi.mock('./docker-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./docker-runner.js')>()),
  defaultDockerRunner: { volumeRemove: async () => ({ ok: true }) },
}));

import { RuntimeRunnerReaper } from './runtime-runner-reaper.js';
import { killTaskDdevRunners, startDdevRunner } from './ddev-runner.js';
import { killTaskAppRunners, startAppRunner } from './app-runner.js';
import {
  killTaskIdeContainers,
  listIdeRunnerSessions,
  startIdeRunner,
  stopIdeRunner,
} from './ide-runner.js';

const TASK = '00000000-0000-4000-8000-000000000001';
const REPO = '00000000-0000-4000-8000-000000000002';
const terminal = { id: TASK, status: 'completed', completedAt: new Date(0), voteScore: 0 };
function container(label: string | undefined, running = true, kind = 'haive.ddev'): Container {
  return {
    running,
    labels: {
      [kind]: '1',
      'haive.task.id': TASK,
      ...(label === undefined ? {} : { [INSTALL_LABEL]: label }),
    },
  };
}
function reaper() {
  return new RuntimeRunnerReaper({
    db: { query: { tasks: { findFirst: h.findTask } } } as unknown as Database,
  });
}

beforeEach(() => {
  vi.stubEnv('HAIVE_INSTALL_ID', 'rio');
  h.containers.clear();
  h.calls.length = 0;
  h.info.mockClear();
  h.task = undefined;
  h.repository = undefined;
  h.findTask.mockReset().mockImplementation(async () => h.task);
  vi.spyOn(configService, 'getNumber').mockResolvedValue(180);
  vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe.each(['haive', 'rio'])('runtime cleanup ownership for install %s', (install) => {
  beforeEach(() => vi.stubEnv('HAIVE_INSTALL_ID', install));
  describe.each(['sweep', 'preemption'])('%s', (mode) => {
    it.each([
      ['foreign orphan', 'elsewhere', false, false],
      ['foreign runner with a matching task id', 'elsewhere', true, false],
      ['unknown legacy runner', undefined, false, false],
      ['known legacy terminal runner', undefined, true, true],
      ['own labeled orphan', 'own', false, true],
    ] as const)('%s', async (_name, label, known, remove) => {
      for (const kind of ['haive.ddev', APP_RUNNER_LABEL]) {
        for (const running of [true, false]) {
          h.containers.clear();
          h.calls.length = 0;
          h.task = known ? terminal : undefined;
          h.containers.set(
            'rio-fixture',
            container(label === 'own' ? installId() : label, running, kind),
          );
          if (mode === 'sweep') await reaper().sweep();
          else await reaper().reclaimOnePreemptible();
          expect(
            h.containers.has('rio-fixture'),
            `${kind}/${mode}/${running}/${label}/${known}`,
          ).toBe(!(remove && (running || mode === 'sweep')));
          if (remove && (running || mode === 'sweep'))
            expect(h.calls).toContainEqual(['rm', '-f', '-v', 'rio-fixture']);
        }
      }
    });
  });
});

it.each(['sweep', 'preemption'])(
  '%s keeps a legacy runner when its task lookup fails',
  async (mode) => {
    h.containers.set('rio-fixture', container(undefined));
    h.findTask.mockRejectedValue(new Error('database unavailable'));
    if (mode === 'sweep') await reaper().sweep();
    else await reaper().reclaimOnePreemptible();
    expect(h.containers.has('rio-fixture')).toBe(true);
  },
);

it.each(['sweep', 'preemption'])(
  '%s keeps a legacy runner if its task disappears during the pass',
  async (mode) => {
    h.containers.set('rio-fixture', container(undefined));
    h.findTask.mockResolvedValueOnce(terminal).mockResolvedValue(undefined);
    if (mode === 'sweep') await reaper().sweep();
    else await reaper().reclaimOnePreemptible();
    expect(h.containers.has('rio-fixture')).toBe(true);
  },
);

it('preemption keeps an owned runner when a failed task lookup would otherwise look like an orphan', async () => {
  h.containers.set('rio-fixture', container(installId()));
  h.findTask.mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValue(undefined);
  await expect(reaper().reclaimOnePreemptible()).resolves.toBe(false);
  expect(h.containers.has('rio-fixture')).toBe(true);
});

it('reports an unowned container once across repeated sweep and preemption passes', async () => {
  h.containers.set('rio-log-once', container('elsewhere'));
  const instance = reaper();
  await instance.sweep();
  await instance.sweep();
  await instance.reclaimOnePreemptible();
  expect(h.containers.has('rio-log-once')).toBe(true);
  expect(h.info.mock.calls.filter(([fields]) => fields.id === 'rio-log-once')).toHaveLength(1);
});

describe('label-selected task-end cleanup', () => {
  it.each([
    ['haive.ddev', killTaskDdevRunners],
    [APP_RUNNER_LABEL, killTaskAppRunners],
    [IDE_RUNNER_LABEL, killTaskIdeContainers],
  ] as const)(
    '%s removes only owned runners, including a legacy runner of a known task',
    async (kind, kill) => {
      for (const known of [false, true]) {
        h.containers.clear();
        h.task = known ? terminal : undefined;
        h.containers.set('rio-own', container(installId(), true, kind));
        h.containers.set('rio-foreign', container('elsewhere', true, kind));
        h.containers.set('rio-legacy', container(undefined, true, kind));
        expect(await kill(TASK)).toBe(known ? 2 : 1);
        expect([...h.containers.keys()]).toEqual(
          known ? ['rio-foreign'] : ['rio-foreign', 'rio-legacy'],
        );
      }
    },
  );
});

it('stamps every runtime creator with the current install label', async () => {
  await startDdevRunner({ taskId: TASK, repoSubpath: 'owner/repo' });
  await startAppRunner({ taskId: TASK, repoSubpath: 'owner/repo', imageTag: 'fixture:image' });
  for (const repositoryId of [undefined, REPO]) {
    await startIdeRunner({
      taskId: repositoryId ? repoIdeSessionId(repositoryId) : TASK,
      repositoryId,
      workspaceSubpath: 'owner/repo',
      gitDataMounts: [],
      extVolume: 'rio-ext',
      udataVolume: 'rio-udata',
    });
  }
  const runs = h.calls.filter((args) => args[0] === 'run');
  expect(runs).toHaveLength(4);
  for (const args of runs) {
    const labelIndex = args.indexOf(`${INSTALL_LABEL}=${installId()}`);
    expect(labelIndex).toBeGreaterThan(0);
    expect(args[labelIndex - 1]).toBe('--label');
  }
});

it.each(['task', 'repository'])(
  'IDE discovery and idle-stop refuse foreign and unknown legacy %s sessions',
  async (kind) => {
    const session = kind === 'task' ? TASK : repoIdeSessionId(REPO);
    const name = ideRunnerName(session);
    for (const [label, known, owned] of [
      ['elsewhere', true, false],
      [undefined, false, false],
      [undefined, true, true],
      ['rio', false, true],
    ] as const) {
      h.containers.clear();
      h.task = kind === 'task' && known ? terminal : undefined;
      h.repository = kind === 'repository' && known ? { id: REPO } : undefined;
      const editor = container(label, true, IDE_RUNNER_LABEL);
      if (kind === 'repository') {
        delete editor.labels['haive.task.id'];
        editor.labels['haive.repo.id'] = REPO;
      }
      h.containers.set(name, editor);
      expect(await listIdeRunnerSessions()).toEqual(owned ? [session] : []);
      expect(await stopIdeRunner(session)).toBe(owned);
      expect(h.containers.has(name)).toBe(!owned);
    }
  },
);
