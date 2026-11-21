import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const h = vi.hoisted(() => ({
  sql: Object.assign(vi.fn(), { end: vi.fn(), options: { parsers: {}, serializers: {} } }),
  initialize: vi.fn(),
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
import * as images from './images.js';
import * as dk from './docker.js';
import * as journal from './journal.js';
import * as run from './run.js';

// The other party is simulated at protocol level on purpose: no import of the lock module.
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
    let seen = 0;
    vi.mocked(run.phaseSnapshot).mockImplementation(async () => {
      const deadline = Date.now() + 2000;
      while (seen < 3 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        try {
          seen = (JSON.parse(await readFile(lock, 'utf8')) as { seq: number }).seq;
        } catch {
          // A read between the truncate and the write is a legal torn record.
        }
      }
      return 'dump.sql';
    });
    expect(await main({ stackLock: { sleep: idleSleep, beatMs: 5 } })).toBe(0);
    expect(seen).toBeGreaterThanOrEqual(3);
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

describe('read-only and absent installs', () => {
  it('--check with no live run does not contend and leaves the record alone', async () => {
    process.argv.push('--check');
    await writeFile(lock, record(ext.token, 'extension', ext.seq));
    const sleep = vi.fn(async () => {
      throw new Error('a read-only check must not observe the lock');
    });
    expect(await main({ stackLock: { ...quick, sleep } })).toBe(0);
    expect(sleep).not.toHaveBeenCalled();
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
