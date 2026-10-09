import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: run }) };
});

import { ddevMigrateDatabase } from './ddev-runner.js';

describe('ddevMigrateDatabase hands the runner its target as one word', () => {
  const NUL = String.fromCharCode(0);
  const handle = { container: 'runner', projectDir: '/repos/user/project' };
  let cwd = '';
  beforeAll(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'haive-migrate-quote-'));
  });
  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true });
  });
  /** The words ddev gets when bash reads the runner's command; other output trails as a word. */
  const ddevWords = (sent: string): string[] => {
    const script = `cd() { :; }\nddev() { printf '%s\\0' "$@"; }\n${sent}`;
    const words = execFileSync('bash', ['-c', script], { cwd, encoding: 'utf8' }).split(NUL);
    return words.at(-1) === '' ? words.slice(0, -1) : words;
  };
  const sentToRunner = (): string => {
    const args = run.mock.calls[0]![1] as string[];
    expect(args.slice(0, 5)).toEqual(['exec', '-u', 'ddev', 'runner', 'bash']);
    return args.at(-1)!;
  };

  beforeEach(() => {
    run.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
  });

  // The control: the check below has to be able to fail, or a green run proves nothing.
  it('sees the words bash makes of a target left unquoted, and they are not the target', () => {
    const unquoted = 'cd /repos/p && ddev utility migrate-database mariadb:10.11; echo x';
    expect(ddevWords(unquoted)).not.toEqual([
      'utility',
      'migrate-database',
      'mariadb:10.11; echo x',
    ]);
    expect(ddevWords(unquoted)).toEqual(['utility', 'migrate-database', 'mariadb:10.11', 'x\n']);
  });

  it('keeps the command for a plain target as it was, with the target quoted', async () => {
    await ddevMigrateDatabase(handle, 'mariadb:10.11');
    expect(sentToRunner()).toBe(
      "cd /repos/user/project && ddev utility migrate-database 'mariadb:10.11'",
    );
  });

  it.each([
    'mariadb:10.11',
    'mysql:8.0',
    'mariadb:10.11; echo x',
    'mysql:$(echo hi)',
    'mysql:8.0 x',
    'mariadb:`echo hi`',
    "mysql:8.0'; echo x; '",
    'mysql:${HOME}',
    'mysql:8.0 # comment',
    'mysql:*',
    'a|b&c>d<e',
    '-n',
  ])('passes the target %j to ddev unchanged', async (target) => {
    await ddevMigrateDatabase(handle, target);
    expect(ddevWords(sentToRunner())).toEqual(['utility', 'migrate-database', target]);
  });
});
