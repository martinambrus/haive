import { describe, it, expect } from 'vitest';
import {
  matchYamlField,
  matchYamlBlockField,
  parseDdevConfig,
  renderDdevConfig,
  slugifyDdevName,
} from './_ddev-config.js';

const MARIADB_CONFIG = `name: myproject
type: drupal10
docroot: web
php_version: "8.3"
webserver_type: nginx-fpm
database:
  type: mariadb
  version: "10.11"
`;

describe('parseDdevConfig', () => {
  it('parses a full mariadb config', () => {
    expect(parseDdevConfig(MARIADB_CONFIG)).toEqual({
      phpVersion: '8.3',
      dbType: 'mariadb',
      dbVersion: '10.11',
      webserver: 'nginx-fpm',
      docroot: 'web',
    });
  });

  it('parses an unquoted mysql config', () => {
    const cfg = `php_version: 8.1\ndatabase:\n  type: mysql\n  version: 8.0\n`;
    const r = parseDdevConfig(cfg);
    expect(r.phpVersion).toBe('8.1');
    expect(r.dbType).toBe('mysql');
    expect(r.dbVersion).toBe('8.0');
  });

  it('parses a postgres config (db type still extracted; reconcile rejects it later)', () => {
    const cfg = `php_version: "8.2"\ndatabase:\n  type: postgres\n  version: "16"\n`;
    expect(parseDdevConfig(cfg)).toMatchObject({ dbType: 'postgres', dbVersion: '16' });
  });

  it('returns nulls for absent fields (no database block, no php_version)', () => {
    expect(parseDdevConfig('name: barebones\n')).toEqual({
      phpVersion: null,
      dbType: null,
      dbVersion: null,
      webserver: null,
      docroot: null,
    });
  });

  it('detects a php-only bump as drift vs a baseline (different phpVersion, same db)', () => {
    const before = parseDdevConfig(MARIADB_CONFIG);
    const after = parseDdevConfig(
      MARIADB_CONFIG.replace('php_version: "8.3"', 'php_version: "8.1"'),
    );
    expect(after.phpVersion).toBe('8.1');
    expect(after.dbType).toBe(before.dbType);
    expect(after.dbVersion).toBe(before.dbVersion);
  });

  it('detects a db-version bump (same php, different db version)', () => {
    const after = parseDdevConfig(MARIADB_CONFIG.replace('version: "10.11"', 'version: "11.4"'));
    expect(after.phpVersion).toBe('8.3');
    expect(after.dbVersion).toBe('11.4');
  });
});

describe('matchYamlField / matchYamlBlockField', () => {
  it('matches top-level scalars, quoted and unquoted', () => {
    expect(matchYamlField('php_version: "8.3"', 'php_version')).toBe('8.3');
    expect(matchYamlField('docroot: web', 'docroot')).toBe('web');
    expect(matchYamlField('name: x', 'missing')).toBeNull();
  });

  it('matches scalars inside a one-level block, not a same-named top-level key', () => {
    const text = `version: top\ndatabase:\n  type: mariadb\n  version: "10.11"\n`;
    expect(matchYamlBlockField(text, 'database', 'version')).toBe('10.11');
    expect(matchYamlBlockField(text, 'database', 'type')).toBe('mariadb');
    // top-level `version: top` must not leak into the block lookup
    expect(matchYamlBlockField(text, 'database', 'missing')).toBeNull();
  });
});

describe('renderDdevConfig + slugifyDdevName', () => {
  it('renders the legacy target (php 5.6 + mariadb 10.11) and round-trips through parseDdevConfig', () => {
    const yaml = renderDdevConfig({
      name: 'My Legacy App',
      phpVersion: '5.6',
      dbType: 'mariadb',
      dbVersion: '10.11',
    });
    expect(yaml).toContain('name: my-legacy-app');
    expect(yaml).toContain('type: php');
    expect(parseDdevConfig(yaml)).toEqual({
      phpVersion: '5.6',
      dbType: 'mariadb',
      dbVersion: '10.11',
      webserver: 'nginx-fpm',
      docroot: null, // omitted when empty → DDEV auto-detects
    });
  });

  it('omits the database block for sqlite/none (DDEV defaults to mariadb)', () => {
    expect(renderDdevConfig({ name: 'x', phpVersion: '8.3', dbType: 'sqlite' })).not.toContain(
      'database:',
    );
    expect(renderDdevConfig({ name: 'x', phpVersion: '8.3', dbType: null })).not.toContain(
      'database:',
    );
  });

  it('omits php_version when not provided', () => {
    expect(renderDdevConfig({ name: 'x' })).not.toContain('php_version');
  });

  it('honors an explicit project type + docroot', () => {
    const yaml = renderDdevConfig({ name: 'x', type: 'drupal', docroot: 'web', phpVersion: '8.3' });
    expect(yaml).toContain('type: drupal');
    expect(parseDdevConfig(yaml).docroot).toBe('web');
  });

  it('slugifies to a DNS-safe DDEV name, falling back to "app"', () => {
    expect(slugifyDdevName('My Legacy App!')).toBe('my-legacy-app');
    expect(slugifyDdevName('___')).toBe('app');
  });
});
