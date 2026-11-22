import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const h = vi.hoisted(() => ({
  sql: Object.assign(vi.fn(), { end: vi.fn(), options: { parsers: {}, serializers: {} } }),
  initialize: vi.fn(),
  dockerExec: vi.fn(),
}));
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: h.dockerExec,
  }),
}));
vi.mock('postgres', () => ({ default: vi.fn(() => h.sql) }));
import postgres from 'postgres';
vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  configService: { initialize: h.initialize },
}));
vi.mock('./journal.js', () => ({
  ensureJournal: vi.fn(),
  findLiveRun: vi.fn(),
  lastDoneChannel: vi.fn(),
  recordRunError: vi.fn(),
  mergeMetadata: vi.fn(),
  recordAttempt: vi.fn(),
  startRun: vi.fn(),
  tryLock: vi.fn(),
}));
vi.mock('./run.js', async (original) => ({
  ...(await original<typeof import('./run.js')>()),
  readEnvVar: vi.fn(),
  resume: vi.fn(),
  rollback: vi.fn(),
  phaseDraining: vi.fn(),
  phaseMaintenance: vi.fn(),
  phaseSnapshot: vi.fn(),
  recordSnapshot: vi.fn(),
  phaseMigrate: vi.fn(),
  phaseVerify: vi.fn(),
  phaseCommit: vi.fn(),
}));
import { main } from './cli.js';
import { UpgradeRefusal } from './refusal.js';
import { STACK_LOCK_BEAT_MS, StackLock } from './stack-lock.js';
import * as images from './images.js';
import * as dk from './docker.js';
import * as journal from './journal.js';
import * as run from './run.js';

// The other party is simulated at protocol level on purpose. The lock module is imported only to
// watch the updater's own beats.
const LOCK = '.haive-stack-lock';
const manifest = {
  manifestVersion: 1,
  channel: 'public',
  version: '9.9.9',
  builtAt: '2026-11-14',
  migrationHead: '0221',
};
const settings: images.ImageSettings = {
  HAIVE_API_IMAGE: '',
  HAIVE_WORKER_IMAGE: '',
  HAIVE_WEB_IMAGE: '',
  HAIVE_CHANNEL: 'public',
  DOCKER_CONFIG: '',
  HAIVE_CHANNEL_REGISTRY: '',
  HAIVE_INSTALL_ID: '',
  HAIVE_OWN_MODULES_HOST_DIR: '',
  HAIVE_BUILDER_IMAGE: '',
  HAIVE_OWN_MODULES_REBUILD_WEB: '',
};
const record = (token: string, holder: string, seq: number): string =>
  `${JSON.stringify({ v: 1, token, holder, startedAt: '2026-11-21T10:00:00.000Z', seq })}\n`;
const liveRun = {
  id: 'live',
  fromVersion: '1.0.0',
  toVersion: '9.9.9',
  channel: 'public',
  startedAt: new Date(),
  phase: 'migrate',
  metadata: { migrationHead: '0221' },
};

let dir: string;
let lock: string;
let argv: string[];
let ext: { token: string; seq: number };
const rawJson = (text: string) => JSON.parse(text) as { holder: string; token: string };
const heldBy = async (): Promise<string | null> => {
  try {
    return rawJson(await readFile(lock, 'utf8')).holder;
  } catch {
    return null;
  }
};
// A held lock must refuse a second exclusive create of the same name.
const exclusionHolds = async (): Promise<boolean> => {
  try {
    await (await open(lock, 'wx')).close();
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EEXIST';
  }
};
const beat = async (): Promise<void> => {
  ext.seq += 1;
  await writeFile(lock, record(ext.token, 'extension', ext.seq));
};
const sleeps = { n: 0 };
const beatingSleep = async (): Promise<void> => {
  sleeps.n += 1;
  await beat();
};
const idleSleep = async (): Promise<void> => {
  sleeps.n += 1;
};
const events = (): string[] =>
  vi.mocked(console.log).mock.calls.map(([line]) => String(JSON.parse(String(line)).event));
const quick = { heartbeat: false, staleMs: 5, pollMs: 1 };

beforeEach(async () => {
  vi.resetAllMocks();
  h.dockerExec.mockResolvedValue({ stdout: '' });
  dir = await mkdtemp(join(tmpdir(), 'rbr-lock-'));
  lock = join(dir, LOCK);
  ext = { token: randomBytes(16).toString('hex'), seq: 1 };
  sleeps.n = 0;
  await writeFile(join(dir, '.env'), `JWT_SECRET=${randomBytes(24).toString('hex')}\n`);
  await writeFile(join(dir, 'docker-compose.yml'), 'services: {}\n');
  await writeFile(join(dir, 'docker-compose.run.yml'), 'services: {}\n');
  argv = process.argv;
  process.argv = [
    'node',
    'updater',
    '--install-dir',
    dir,
    '--manifest',
    'https://release.test/release.json',
    '--version',
    '9.9.9',
    '--postgres-volume',
    'vol',
  ];
  vi.mocked(postgres)
    .mockReset()
    .mockReturnValue(h.sql as never);
  vi.stubEnv('DATABASE_URL', 'postgres://isolated');
  vi.stubEnv('REDIS_URL', 'redis://isolated');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(manifest))),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(images, 'readImageSettings').mockResolvedValue({ ...settings });
  vi.spyOn(images, 'prepareImages').mockResolvedValue(images.emptyOverrides());
  vi.spyOn(dk, 'localImages').mockResolvedValue(
    (['api', 'worker', 'web'] as const).map((host) =>
      images.imageFor(host, '1.0.0', 'ghcr.io/martinambrus'),
    ),
  );
  vi.mocked(journal.tryLock).mockResolvedValue(true);
  vi.mocked(journal.findLiveRun).mockResolvedValue(null);
  vi.mocked(journal.lastDoneChannel).mockResolvedValue(null);
  vi.mocked(journal.startRun).mockResolvedValue('new-run');
  vi.mocked(run.phaseVerify).mockResolvedValue(true);
  vi.mocked(run.phaseSnapshot).mockResolvedValue('dump.sql');
  vi.mocked(run.readEnvVar).mockResolvedValue('1.0.0');
  h.sql.end.mockResolvedValue(undefined);
});
afterEach(async () => {
  process.argv = argv;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

describe('race, updater side: another holder of the install stack lock', () => {
  it('refuses with install-locked before any run, drain or snapshot, leaving the record alone', async () => {
    await writeFile(lock, record(ext.token, 'extension', ext.seq));
    expect(await main({ stackLock: { ...quick, sleep: beatingSleep } })).toBe(3);
    expect(journal.startRun).not.toHaveBeenCalled();
    expect(run.phaseDraining).not.toHaveBeenCalled();
    expect(run.phaseSnapshot).not.toHaveBeenCalled();
    expect(journal.recordAttempt).toHaveBeenCalledWith(
      h.sql,
      expect.objectContaining({ status: 'refused', metadata: { refusal: 'install-locked' } }),
    );
    expect(await readFile(lock, 'utf8')).toBe(record(ext.token, 'extension', ext.seq));
    expect((await readdir(dir)).sort()).toEqual(
      ['.env', LOCK, 'docker-compose.run.yml', 'docker-compose.yml'].sort(),
    );
  });
  it('never breaks a holder that keeps beating, however often it is observed', async () => {
    await writeFile(lock, record(ext.token, 'extension', ext.seq));
    const inode = (await stat(lock)).ino;
    for (let i = 0; i < 4; i++) {
      expect(await main({ stackLock: { ...quick, sleep: beatingSleep } })).toBe(3);
      // Checked after every run: a move-aside and restore alternates between two inode numbers.
      expect((await stat(lock)).ino).toBe(inode);
    }
    expect(rawJson(await readFile(lock, 'utf8')).token).toBe(ext.token);
    expect(run.phaseSnapshot).not.toHaveBeenCalled();
  });
});

describe('race, other direction: the updater lock is exclusive for the whole run', () => {
  const opts = { stackLock: { ...quick, sleep: idleSleep } };
  const seen: Array<[string, string | null, boolean]> = [];
  const probe = (phase: string) => async () => {
    seen.push([phase, await heldBy(), await exclusionHolds()]);
  };
  beforeEach(() => {
    seen.length = 0;
  });
  it('holds as updater through snapshot, migrate and verify', async () => {
    vi.mocked(run.phaseSnapshot).mockImplementation(async () => {
      await probe('snapshot')();
      return 'dump.sql';
    });
    vi.mocked(run.phaseMigrate).mockImplementation(probe('migrate'));
    vi.mocked(run.phaseVerify).mockImplementation(async () => {
      await probe('verify')();
      return true;
    });
    expect(await main(opts)).toBe(0);
    expect(seen).toEqual([
      ['snapshot', 'updater', true],
      ['migrate', 'updater', true],
      ['verify', 'updater', true],
    ]);
  });
  it('still holds while a failed verify is rolled back', async () => {
    vi.mocked(run.phaseVerify).mockResolvedValue(false);
    vi.mocked(run.rollback).mockImplementation(probe('rollback'));
    expect(await main(opts)).toBe(5);
    expect(seen).toEqual([['rollback', 'updater', true]]);
  });
});

describe('a long phase keeps the lock live', () => {
  it('rewrites the record on its own timer while a phase runs, with the default heartbeat', async () => {
    // Only the heartbeat's interval is faked; the lock's file operations stay real and are awaited.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const beat = vi.spyOn(StackLock.prototype, 'beat');
    const seqs: number[] = [];
    vi.mocked(run.phaseSnapshot).mockImplementation(async () => {
      for (let tick = 0; tick < 3; tick++) {
        await vi.advanceTimersByTimeAsync(STACK_LOCK_BEAT_MS);
        // The tick starts one beat; wait for that beat, then read what it wrote.
        await beat.mock.results.at(-1)!.value;
        seqs.push((JSON.parse(await readFile(lock, 'utf8')) as { seq: number }).seq);
      }
      return 'dump.sql';
    });
    expect(await main({ stackLock: { sleep: idleSleep } })).toBe(0);
    expect(seqs).toEqual([2, 3, 4]);
    expect(await heldBy()).toBeNull();
  });
});

describe('every exit path releases the lock', () => {
  const opts = { stackLock: { ...quick, sleep: idleSleep } };
  let during: Array<string | null>;
  const mark = async () => {
    during.push(await heldBy());
  };
  beforeEach(() => {
    during = [];
    vi.mocked(journal.lastDoneChannel).mockImplementation(async () => {
      await mark();
      return null;
    });
  });
  const gone = async () => expect(await heldBy()).toBeNull();
  const files = async () => expect(await readdir(dir)).toHaveLength(3);

  it('exit 0', async () => {
    const sigint = process.listenerCount('SIGINT');
    const sigterm = process.listenerCount('SIGTERM');
    expect(await main(opts)).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(sigint);
    expect(process.listenerCount('SIGTERM')).toBe(sigterm);
    expect(during).toEqual(['updater']);
    await gone();
    await files();
  });
  it('preflight refusal 3', async () => {
    vi.mocked(journal.lastDoneChannel).mockImplementation(async () => {
      await mark();
      return 'other';
    });
    expect(await main(opts)).toBe(3);
    expect(during).toEqual(['updater']);
    await gone();
    await files();
  });
  it('a thrown error rejects and still releases', async () => {
    vi.spyOn(dk, 'localImages').mockImplementation(async () => {
      await mark();
      throw new Error('docker unreachable');
    });
    await expect(main(opts)).rejects.toThrow('docker unreachable');
    expect(during).toEqual(['updater', 'updater']);
    await gone();
    await files();
  });
  it('leaves the run for recovery when a cancelled child cannot be removed', async () => {
    vi.mocked(run.phaseMigrate).mockRejectedValue(
      new UpgradeRefusal(
        'updater-child-cleanup-failed',
        'could not stop migration containers (EACCES)',
      ),
    );
    expect(await main(opts)).toBe(3);
    expect(run.rollback).not.toHaveBeenCalled();
    expect(run.phaseVerify).not.toHaveBeenCalled();
    expect(journal.recordAttempt).not.toHaveBeenCalled();
    await gone();
  });
  it('verify failure rolled back 5', async () => {
    vi.mocked(run.phaseVerify).mockResolvedValue(false);
    vi.mocked(run.rollback).mockImplementation(mark);
    expect(await main(opts)).toBe(5);
    expect(during).toEqual(['updater', 'updater']);
    await gone();
    await files();
  });
  it('rollback that throws 6', async () => {
    vi.mocked(run.phaseVerify).mockResolvedValue(false);
    vi.mocked(run.rollback).mockImplementation(async () => {
      await mark();
      throw new Error('restore failed');
    });
    vi.mocked(journal.recordRunError).mockResolvedValue(undefined);
    expect(await main(opts)).toBe(6);
    expect(during).toEqual(['updater', 'updater']);
    await gone();
    await files();
  });
  it('commit failure 1', async () => {
    vi.mocked(run.phaseCommit).mockImplementation(async () => {
      await mark();
      throw new Error('commit failed');
    });
    expect(await main(opts)).toBe(1);
    expect(during).toEqual(['updater', 'updater']);
    await gone();
    await files();
  });
  it('resume of a live run', async () => {
    vi.mocked(journal.findLiveRun).mockResolvedValue(liveRun as never);
    vi.mocked(run.resume).mockImplementation(mark);
    expect(await main(opts)).toBe(0);
    expect(during).toEqual(['updater']);
    await gone();
    await files();
  });
  it('a busy database lock never creates it', async () => {
    vi.mocked(journal.tryLock).mockResolvedValue(false);
    const created = vi.spyOn(dk, 'localImages');
    expect(await main(opts)).toBe(4);
    expect(during).toEqual([]);
    expect(created).not.toHaveBeenCalled();
    await gone();
    await files();
  });
});

describe('crash recovery of an abandoned record', () => {
  it.each([false, true])(
    'refuses a surviving one-shot after breaking the dead holder lease (recovery=%s)',
    async (recover) => {
      await writeFile(lock, record(ext.token, 'updater', ext.seq));
      if (recover) vi.mocked(journal.findLiveRun).mockResolvedValue(liveRun as never);
      h.dockerExec.mockResolvedValue({ stdout: 'abc123\tdead-holder-attempt\tmigration\n' });
      expect(await main({ stackLock: { ...quick, sleep: idleSleep } })).toBe(3);
      expect(events()).toContain('stack-lock-broken');
      expect(run.resume).not.toHaveBeenCalled();
      expect(journal.startRun).not.toHaveBeenCalled();
      expect(run.phaseDraining).not.toHaveBeenCalled();
      expect(run.phaseSnapshot).not.toHaveBeenCalled();
      expect(images.prepareImages).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(
        vi.mocked(console.log).mock.calls.map(([line]) => JSON.parse(String(line))),
      ).toContainEqual(
        expect.objectContaining({ event: 'refused', refusal: 'updater-child-running' }),
      );
      expect(await heldBy()).toBeNull();
      if (!recover) {
        expect(journal.recordAttempt).toHaveBeenCalledWith(
          h.sql,
          expect.objectContaining({
            status: 'refused',
            metadata: { refusal: 'updater-child-running' },
          }),
        );
      }
    },
  );
  it('refuses an unavailable Docker check before recovery and releases the lease', async () => {
    vi.mocked(journal.findLiveRun).mockResolvedValue(liveRun as never);
    h.dockerExec.mockRejectedValue(new Error('docker unavailable'));
    expect(await main({ stackLock: { ...quick, sleep: idleSleep } })).toBe(3);
    expect(run.resume).not.toHaveBeenCalled();
    expect(images.prepareImages).not.toHaveBeenCalled();
    expect(await heldBy()).toBeNull();
    expect(
      vi.mocked(console.log).mock.calls.map(([line]) => JSON.parse(String(line))),
    ).toContainEqual(
      expect.objectContaining({ event: 'refused', refusal: 'updater-child-check-failed' }),
    );
  });
  it('uses the install identity even when the network is overridden', async () => {
    vi.stubEnv('HAIVE_INSTALL_ID', 'team_install');
    process.argv.push('--network', 'custom-network');
    h.dockerExec.mockResolvedValue({ stdout: 'abc123\tprior\tmigration\n' });
    expect(await main({ stackLock: { ...quick, sleep: idleSleep } })).toBe(3);
    expect(h.dockerExec.mock.calls[0]![1]).toEqual([
      'ps',
      '--filter',
      'label=haive.install=team_install',
      '--filter',
      'label=org.haive.updater.attempt',
      '--filter',
      'label=org.haive.updater.role',
      '--format',
      '{{.ID}}\t{{.Label "org.haive.updater.attempt"}}\t{{.Label "org.haive.updater.role"}}',
    ]);
  });
  it('checks children using the install Docker config that subsequent launches use', async () => {
    vi.stubEnv('DOCKER_CONFIG', '/ambient');
    vi.mocked(images.readImageSettings).mockResolvedValue({
      ...settings,
      HAIVE_CHANNEL: 'acme',
      DOCKER_CONFIG: join(dir, '.docker'),
    });
    let checkedConfig: string | undefined;
    h.dockerExec.mockImplementation(async () => {
      checkedConfig = process.env.DOCKER_CONFIG;
      return { stdout: 'abc123\tdead-holder-attempt\tmigration\n' };
    });
    expect(await main({ stackLock: { ...quick, sleep: idleSleep } })).toBe(3);
    expect(checkedConfig).toBe(join(dir, '.docker'));
    expect(journal.recordAttempt).toHaveBeenCalledWith(
      h.sql,
      expect.objectContaining({
        channel: 'acme',
        fromVersion: '1.0.0',
        metadata: { refusal: 'updater-child-running' },
      }),
    );
    expect(run.resume).not.toHaveBeenCalled();
    expect(images.prepareImages).not.toHaveBeenCalled();
  });
  it('breaks a record that never changes after exactly staleMs of sleeps, then proceeds', async () => {
    await writeFile(lock, record(ext.token, 'extension', ext.seq));
    expect(await main({ stackLock: { ...quick, sleep: idleSleep } })).toBe(0);
    expect(events()).toContain('stack-lock-broken');
    expect(sleeps.n).toBe(5);
    expect(await heldBy()).toBeNull();
    expect(await readdir(dir)).toHaveLength(3);
  });
  it('still honours the record when it beats on the last poll before the stale boundary', async () => {
    await writeFile(lock, record(ext.token, 'extension', ext.seq));
    const sleep = async () => {
      sleeps.n += 1;
      if (sleeps.n === 4) await beat();
    };
    expect(await main({ stackLock: { ...quick, sleep } })).toBe(3);
    expect(events()).not.toContain('stack-lock-broken');
    expect(rawJson(await readFile(lock, 'utf8')).token).toBe(ext.token);
  });
  it('honours the record one poll short of the stale window', async () => {
    await writeFile(lock, record(ext.token, 'extension', ext.seq));
    let count = 0;
    const sleep = async () => {
      count += 1;
      // The holder beats on the fifth requested sleep, i.e. as the window would close.
      if (count === 5) await beat();
    };
    const outcome = await main({ stackLock: { ...quick, staleMs: 6, sleep } });
    expect(outcome).toBe(3);
    expect(count).toBe(5);
  });
});

describe('the live run is read again under the lock', () => {
  // The first updater's snapshot restarts PostgreSQL, which ends its session lock on the database. A
  // second updater then passes tryLock, reads the first one's live run and waits for the stack lock.
  // The first updater's end (the journal changes, its lock file goes) lands during that wait, so
  // what the second one read before the wait is out of date. The hook below is that end, and it
  // runs inside the second updater's own poll, so nothing depends on timing.
  const firstUpdaterEnds = (journalAfter: typeof liveRun | null) => async (): Promise<void> => {
    vi.mocked(journal.findLiveRun).mockResolvedValue(journalAfter as never);
    await rm(lock, { force: true });
  };
  // The install-file writer's temp name for .env; the updater's cleanup removes it.
  const leftoverName = () => `..env.${randomUUID()}`;
  beforeEach(async () => {
    vi.mocked(journal.findLiveRun).mockResolvedValue(liveRun as never);
    await writeFile(lock, record(ext.token, 'updater', ext.seq));
  });
  it('neither resumes nor rolls back a run that finished during the wait', async () => {
    const leftover = join(dir, leftoverName());
    await writeFile(leftover, 'crashed writer');
    const outcome = await main({ stackLock: { ...quick, sleep: firstUpdaterEnds(null) } });
    expect(outcome).toBe(0);
    expect(run.resume).not.toHaveBeenCalled();
    expect(run.rollback).not.toHaveBeenCalled();
    expect(journal.startRun).toHaveBeenCalledTimes(1);
    // The run that acts cleans the leftover, which makes the check below meaningful.
    await expect(stat(leftover)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await heldBy()).toBeNull();
  });
  it('recovers from the run as it is under the lock, not as it was before the wait', async () => {
    const later = { ...liveRun, phase: 'verify' };
    expect(await main({ stackLock: { ...quick, sleep: firstUpdaterEnds(later) } })).toBe(0);
    expect(run.resume).toHaveBeenCalledTimes(1);
    expect(run.resume).toHaveBeenCalledWith(expect.objectContaining({ runId: 'live' }), 'verify');
    expect(run.rollback).not.toHaveBeenCalled();
    expect(journal.startRun).not.toHaveBeenCalled();
  });
  it('recovers a run that began during the wait instead of starting a second one', async () => {
    vi.mocked(journal.findLiveRun).mockResolvedValue(null);
    expect(await main({ stackLock: { ...quick, sleep: firstUpdaterEnds(liveRun) } })).toBe(0);
    expect(run.resume).toHaveBeenCalledWith(expect.objectContaining({ runId: 'live' }), 'migrate');
    expect(journal.startRun).not.toHaveBeenCalled();
  });
  it('records a later refusal as an attempt, since the run it saw no longer exists', async () => {
    vi.mocked(journal.lastDoneChannel).mockResolvedValue('other');
    expect(await main({ stackLock: { ...quick, sleep: firstUpdaterEnds(null) } })).toBe(3);
    expect(journal.recordAttempt).toHaveBeenCalledWith(
      h.sql,
      expect.objectContaining({ status: 'refused', metadata: { refusal: 'channel-changed' } }),
    );
  });
  it('stays read-only for a --check whose live run finished during the wait', async () => {
    process.argv.push('--check');
    // A crashed writer's leftover is cleaned only by a run that acts, never by a read-only check.
    const leftover = join(dir, leftoverName());
    await writeFile(leftover, 'crashed writer');
    expect(await main({ stackLock: { ...quick, sleep: firstUpdaterEnds(null) } })).toBe(0);
    expect(run.resume).not.toHaveBeenCalled();
    expect(journal.startRun).not.toHaveBeenCalled();
    expect(await readFile(leftover, 'utf8')).toBe('crashed writer');
    expect(await heldBy()).toBeNull();
  });
});

describe('read-only and absent installs', () => {
  it('--check with no live run does not contend and leaves the record alone', async () => {
    process.argv.push('--check');
    await writeFile(lock, record(ext.token, 'extension', ext.seq));
    const sleep = vi.fn(async () => {
      throw new Error('a read-only check must not observe the lock');
    });
    expect(await main({ stackLock: { ...quick, sleep } })).toBe(0);
    expect(sleep).not.toHaveBeenCalled();
    expect(h.dockerExec).not.toHaveBeenCalled();
    expect(await readFile(lock, 'utf8')).toBe(record(ext.token, 'extension', ext.seq));
    expect(await readdir(dir)).toHaveLength(4);
  });
  it('--check with a live run does contend', async () => {
    process.argv.push('--check');
    vi.mocked(journal.findLiveRun).mockResolvedValue(liveRun as never);
    await writeFile(lock, record(ext.token, 'extension', ext.seq));
    expect(await main({ stackLock: { ...quick, sleep: beatingSleep } })).toBe(3);
    expect(run.resume).not.toHaveBeenCalled();
  });
  it('a nonexistent install directory takes no lock and the run proceeds', async () => {
    process.argv[process.argv.indexOf('--install-dir') + 1] = '/host/install-absent';
    process.argv.push('--check');
    vi.mocked(journal.findLiveRun).mockResolvedValue(liveRun as never);
    expect(await main()).toBe(0);
    expect(events()).toContain('stack-lock-skipped');
    expect(run.resume).toHaveBeenCalled();
  });
});
