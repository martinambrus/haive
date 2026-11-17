import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanRepoForDeps } from '../src/step-engine/steps/env-replicate/01-declare-deps.js';
import { renderDockerfile } from '../src/step-engine/steps/env-replicate/02-generate-dockerfile.js';

const databases = [
  ['sqlite', 'sqlite3', 'sqlite3'],
  ['postgres', 'pgsql', 'postgresql-client'],
  ['mysql', 'mysql', 'default-mysql-client'],
  ['mariadb', 'mysql', 'default-mysql-client'],
] as const;

describe('PHP database packages', () => {
  for (const version of [undefined, '7.4', '8.3.12', '5.5']) {
    it.each(databases)(
      `installs %s's driver with PHP ${version ?? 'default'}`,
      (kind, ext, client) => {
        const resolved = version === '5.5' ? '5.6' : version?.startsWith('7.') ? '7.4' : '8.3';
        const df = renderDockerfile('ubuntu:24.04', {
          runtimes: ['php'],
          versions: version ? { php: version } : {},
          database: { kind },
        });
        const install = df.split('\n').find((line) => line.includes(`php${resolved}-cli`))!;
        expect(install.split(' ')).toContain(`php${resolved}-${ext}`);
        expect(df).toContain(`--no-install-recommends ${client}`);
        if (resolved !== '8.3') {
          expect(df.indexOf('add-apt-repository -y ppa:ondrej/php')).toBeLessThan(
            df.indexOf(install),
          );
        }
      },
    );
  }

  it('adds all Composer drivers alongside the declared database, once each', () => {
    const df = renderDockerfile('ubuntu:24.04', {
      runtimes: ['php'],
      database: { kind: 'sqlite' },
      phpDatabaseExtensions: ['mysql', 'pgsql', 'sqlite3', 'sqlite3'],
    });
    for (const ext of ['mysql', 'pgsql', 'sqlite3']) {
      expect(df.match(new RegExp(`php8\\.3-${ext}\\b`, 'g'))).toHaveLength(1);
    }
  });

  it('keeps DDEV bytes unchanged even with Composer requirements', () => {
    const deps = { runtimes: ['php'], containerTool: 'ddev', database: { kind: 'sqlite' } };
    expect(renderDockerfile('ubuntu:24.04', { ...deps, phpDatabaseExtensions: ['sqlite3'] })).toBe(
      renderDockerfile('ubuntu:24.04', deps),
    );
  });

  it('does not install PHP drivers without a PHP runtime or database requirement', () => {
    expect(renderDockerfile('ubuntu:24.04', { database: { kind: 'sqlite' } })).not.toMatch(
      /php[\d.]+-/,
    );
    expect(
      renderDockerfile('ubuntu:24.04', { runtimes: ['php'], database: { kind: 'none' } }),
    ).not.toMatch(/php8\.3-(sqlite3|pgsql|mysql)/);
  });
});

describe('Composer database requirements through the existing manifest scan', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'php-db-'));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    ['ext-pdo_sqlite', 'sqlite3'],
    ['ext-sqlite3', 'sqlite3'],
    ['ext-pdo_pgsql', 'pgsql'],
    ['ext-pgsql', 'pgsql'],
    ['ext-pdo_mysql', 'mysql'],
    ['ext-mysqli', 'mysql'],
  ])('carries %s into generation without a declared database', async (requirement, ext) => {
    await writeFile(
      path.join(root, 'composer.json'),
      JSON.stringify({ require: { php: '^8.3', [requirement]: '*' } }),
    );
    const detected = await scanRepoForDeps(root);
    expect(detected).toMatchObject({ phpDatabaseExtensions: [ext] });
    expect(renderDockerfile('ubuntu:24.04', { ...detected, runtimes: ['php'] })).toContain(
      `php8.3-${ext}`,
    );
  });

  it('ignores require-dev and unrelated extension names', async () => {
    await writeFile(
      path.join(root, 'composer.json'),
      JSON.stringify({
        require: { php: '^8.3', 'ext-curl': '*', 'ext-pdo': '*', 'ext-pdo_mysql-extra': '*' },
        'require-dev': { 'ext-pdo_sqlite': '*' },
      }),
    );
    expect(await scanRepoForDeps(root)).not.toHaveProperty('phpDatabaseExtensions');
  });
});
