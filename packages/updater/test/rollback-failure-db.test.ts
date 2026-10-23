import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres, { type Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const control = vi.hoisted(() => ({
  composeUp: async (): Promise<void> => undefined,
  runOneShot: async (): Promise<string> => 'ok',
  verified: true,
  rollbacks: 0,
  stored: 'normal',
}));

vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: {
    initialize: async () => undefined,
    set: async (_key: string, value: string) => {
      control.stored = value;
    },
    getFresh: async () => control.stored,
  },
}));

vi.mock('../src/docker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/docker.js')>()),
  localImages: async () => [],
  pullImages: async () => undefined,
  composeUp: () => control.composeUp(),
  runOneShot: () => control.runOneShot(),
}));
vi.mock('../src/preflight.js', () => ({ preflight: () => ({ ok: true }) }));
vi.mock('../src/run.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/run.js')>();
  return {
    ...real,
    phaseVerify: async () => control.verified,
    rollback: (...args: Parameters<typeof real.rollback>) => {
      control.rollbacks++;
      return real.rollback(...args);
    },
  };
});

const url = process.env.UPDATER_ROLLBACK_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/updater_rollback_test'))
  throw new Error('Use a dedicated updater_rollback_test database for the rollback tests');

describe.skipIf(!url)(
  'a rollback that throws, through the updater entry point',
  { timeout: 20_000 },
  () => {
    let sql: Sql;
    let dir: string;
    let logs: { event: string; [k: string]: unknown }[];
    let exitCode: number | undefined;

    const runUpdater = async (...extra: string[]): Promise<number | undefined> => {
      exitCode = undefined;
      process.argv = [
        'node',
        'cli.js',
        '--install-dir',
        dir,
        '--manifest',
        join(dir, 'manifest.json'),
        '--force',
        '--drain-timeout',
        '0',
        ...extra,
      ];
      vi.resetModules();
      await import('../src/cli.js');
      await vi.waitFor(() => expect(exitCode, JSON.stringify(logs)).toBeDefined(), {
        timeout: 4000,
      });
      return exitCode;
    };

    const run = async () => {
      const [row] = await sql<{ status: string; error: string | null; ended_at: Date | null }[]>`
      SELECT status, error, ended_at FROM upgrade_runs ORDER BY started_at DESC LIMIT 1`;
      return row!;
    };

    beforeAll(async () => {
      sql = postgres(url as string, { max: 1 });
      dir = await mkdtemp(join(tmpdir(), 'rollback-failure-'));
    });

    beforeEach(async () => {
      await sql`DROP TABLE IF EXISTS upgrade_runs`;
      await writeFile(join(dir, '.env'), 'HAIVE_VERSION=1.0.0\n');
      await writeFile(
        join(dir, 'manifest.json'),
        JSON.stringify({
          manifestVersion: 1,
          version: '1.1.0',
          builtAt: '2026-01-01T00:00:00.000Z',
          minFrom: '0.0.0',
          migrationHead: '0208_repositories_rtk_choice_made_at',
        }),
      );
      control.stored = 'normal';
      logs = [];
      control.composeUp = async () => undefined;
      control.runOneShot = async () => 'ok';
      control.verified = true;
      control.rollbacks = 0;
      process.env.DATABASE_URL = url;
      process.env.REDIS_URL = 'redis://unused';
      vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
        if (typeof line === 'string') logs.push(JSON.parse(line));
      });
      vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        exitCode = code ?? 0;
      }) as never);
    });

    afterEach(() => vi.restoreAllMocks());

    afterAll(async () => {
      await sql`DROP TABLE IF EXISTS upgrade_runs`;
      await sql.end({ timeout: 5 });
      await rm(dir, { recursive: true, force: true });
    });

    const failRollback = () => {
      control.runOneShot = async () => {
        throw new Error('migrate blew up');
      };
      control.composeUp = async () => {
        throw new Error('compose down');
      };
    };

    it('keeps the run running with the error recorded, exits 6, and leaves the hold in place', async () => {
      failRollback();

      expect(await runUpdater()).toBe(6);

      const row = await run();
      expect(row.status).toBe('running');
      expect(row.ended_at).toBeNull();
      expect(row.error).toContain('compose down');
      expect(control.stored).toBe('maintenance');
      expect(logs.some((l) => l.event === 'rollback-failed')).toBe(true);
    });

    it('is finished by the next run, which rolls back and restores the state it found', async () => {
      control.stored = 'maintenance';
      failRollback();
      await runUpdater();

      control.composeUp = async () => undefined;
      expect(await runUpdater()).toBe(0);

      const row = await run();
      expect(row.status).toBe('rolled_back');
      expect(row.ended_at).not.toBeNull();
      expect(control.stored).toBe('maintenance');
      expect(logs.some((l) => l.event === 'resume')).toBe(true);
    });

    it('restores a normal install to normal when the next run finishes the rollback', async () => {
      failRollback();
      await runUpdater();
      expect(control.stored).toBe('maintenance');

      control.composeUp = async () => undefined;
      await runUpdater();

      expect(control.stored).toBe('normal');
    });

    it('attempts the rollback once when verification fails and the rollback throws', async () => {
      control.verified = false;
      control.composeUp = async () => {
        throw new Error('compose down');
      };

      expect(await runUpdater()).toBe(6);

      expect(control.rollbacks).toBe(1);
      expect((await run()).status).toBe('running');
    });

    it('closes the run rolled_back and exits 5 when the rollback succeeds', async () => {
      control.runOneShot = async () => {
        throw new Error('migrate blew up');
      };

      expect(await runUpdater()).toBe(5);

      const row = await run();
      expect(row.status).toBe('rolled_back');
      expect(row.error).toContain('migrate blew up');
      expect(control.stored).toBe('normal');
    });

    it('closes a verification failure rolled_back and exits 5 when the rollback succeeds', async () => {
      control.verified = false;

      expect(await runUpdater()).toBe(5);

      expect(control.rollbacks).toBe(1);
      expect((await run()).status).toBe('rolled_back');
    });
  },
);
