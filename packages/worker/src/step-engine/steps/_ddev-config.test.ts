import { describe, it, expect } from 'vitest';
import {
  matchYamlField,
  matchYamlBlockField,
  parseDdevConfig,
  renderDdevConfig,
  slugifyDdevName,
  ddevUrlFromConfigText,
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

// 07c plans a migration or refuses PostgreSQL from these reads: quotes and comments must not leak.
describe('matchYamlBlockField: a scalar as YAML reads it', () => {
  const read = (written: string, key = 'version') =>
    matchYamlBlockField(`name: app\ndatabase:\n  ${key}: ${written}\n`, 'database', key);

  it.each([
    ['"10.11"', '10.11'],
    ["'10.11'", '10.11'],
    ['10.11', '10.11'],
    ['"10.11" # lts', '10.11'],
    ["'10.11' # lts", '10.11'],
    ['10.11 # lts', '10.11'],
    ['"10.11"   # lts', '10.11'],
    ['10.11\t# lts', '10.11'],
    ['"10.11"  ', '10.11'],
    ['10.11  ', '10.11'],
    ['10.11#lts', '10.11#lts'],
    ['"10.11 # lts"', '"10.11 # lts"'],
    ["'10.11 # lts'", "'10.11 # lts'"],
  ])('reads version: %s as %s', (written, expected) => {
    expect(read(written)).toBe(expected);
  });

  it.each([
    ["'postgres'", 'postgres'],
    ['"postgres"', 'postgres'],
    ['postgres # engine', 'postgres'],
    ["'postgres' # engine", 'postgres'],
  ])('reads type: %s as %s', (written, expected) => {
    expect(read(written, 'type')).toBe(expected);
  });

  it.each(['""', "''", '""  # lts', '# lts', ''])('reads no value from version: %s', (written) => {
    expect(read(written)).toBeNull();
  });

  // What YAML cannot read as one scalar stays whole, so 07c refuses it, not a made-up version.
  it.each([
    ['"10.11" x', '"10.11" x'],
    ["'10.11", "'10.11"],
    ['10.11"', '10.11"'],
    ['"10.11\'', '"10.11\''],
  ])('hands version: %s on whole', (written, expected) => {
    expect(read(written)).toBe(expected);
  });

  it('reads a long run of whitespace in linear time', () => {
    const started = performance.now();
    const value = read(`${' '.repeat(2500)}a"b`);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(value).toBe('a"b');
  });

  it('reads a DDEV-style block with comments after its values', () => {
    const cfg = [
      'name: myproject',
      'type: drupal10',
      'docroot: web',
      'php_version: "8.3"',
      'database:',
      "    type: 'mariadb' # engine",
      '    version: "10.11" # lts',
      'use_dns_when_possible: true',
      '',
    ].join('\n');
    expect(parseDdevConfig(cfg)).toEqual({
      phpVersion: '8.3',
      dbType: 'mariadb',
      dbVersion: '10.11',
      webserver: null,
      docroot: 'web',
    });
  });
});

describe('parseDdevConfig: line endings and quoted comment marks', () => {
  it('reads a database block written with CRLF line endings', () => {
    const cfg = ['name: p', 'database:', '  type: mariadb', '  version: "10.11"', ''].join('\r\n');
    expect(parseDdevConfig(cfg)).toMatchObject({ dbType: 'mariadb', dbVersion: '10.11' });
  });

  it('hands on whole a quoted value holding " #", so 07c refuses it', () => {
    const cfg = ['database:', '  type: mariadb', "  version: '10.11 # lts'", ''].join('\n');
    expect(parseDdevConfig(cfg).dbVersion).toBe("'10.11 # lts'");
  });
});

describe('parseDdevConfig: a document read as YAML', () => {
  it('reads a trailing comment after a top-level quoted value', () => {
    expect(parseDdevConfig('php_version: "8.3" # lts\n').phpVersion).toBe('8.3');
  });

  it('reads a comment after `database:` and a quoted type', () => {
    const cfg = "database: # engine\n  type: 'postgres'\n  version: '10.11'\n";
    expect(parseDdevConfig(cfg)).toMatchObject({ dbType: 'postgres', dbVersion: '10.11' });
  });

  it('reads the flow-mapping form of `database:`', () => {
    const cfg = 'database: {type: mysql, version: "8.0"}\n';
    expect(parseDdevConfig(cfg)).toMatchObject({ dbType: 'mysql', dbVersion: '8.0' });
  });

  it('keeps a number as the text written, not the number it coerces to', () => {
    const cfg = 'php_version: 8.10\ndatabase:\n  type: mariadb\n  version: 10.11\n';
    expect(parseDdevConfig(cfg)).toMatchObject({ phpVersion: '8.10', dbVersion: '10.11' });
  });

  it('reads a non-scalar where a scalar is expected as null', () => {
    const cfg = 'php_version: [8, 3]\ndatabase:\n  type:\n    a: b\n  version: "8.0"\n';
    expect(parseDdevConfig(cfg)).toMatchObject({
      phpVersion: null,
      dbType: null,
      dbVersion: '8.0',
    });
  });

  it('falls back to the line readers for a document YAML reports errors for', () => {
    const cfg = [
      'php_version: "8.3"',
      'docroot: web',
      'docroot: web2',
      'database:',
      '  type: mysql',
      '  version: "8.0"',
      '',
    ].join('\n');
    expect(parseDdevConfig(cfg)).toEqual({
      phpVersion: '8.3',
      dbType: 'mysql',
      dbVersion: '8.0',
      webserver: null,
      docroot: 'web',
    });
  });

  it('falls back for bad indentation too', () => {
    const cfg = 'php_version: 8.2\ndatabase:\n  type: mysql\n version: 8.0\n';
    expect(parseDdevConfig(cfg)).toMatchObject({ phpVersion: '8.2', dbType: 'mysql' });
  });
});

describe('parseDdevConfig: aliases and merge keys', () => {
  it('resolves an aliased database type, as DDEV does', () => {
    const cfg = 'name: &engine postgres\ndatabase: {type: *engine, version: "16"}\n';
    expect(parseDdevConfig(cfg)).toMatchObject({ dbType: 'postgres', dbVersion: '16' });
  });

  it('resolves an aliased php_version and an aliased database block', () => {
    const cfg = [
      'x-php: &php "8.3"',
      'x-db: &db',
      '  type: mysql',
      '  version: "8.0"',
      'php_version: *php',
      'database: *db',
      '',
    ].join('\n');
    expect(parseDdevConfig(cfg)).toMatchObject({
      phpVersion: '8.3',
      dbType: 'mysql',
      dbVersion: '8.0',
    });
  });

  it('reads an alias to an undefined anchor as null', () => {
    expect(parseDdevConfig('php_version: *nope\n').phpVersion).toBeNull();
  });

  it('reads a merged database block, as DDEV does', () => {
    const cfg = [
      'x-db: &db',
      '  type: postgres',
      '  version: "16"',
      'php_version: "8.3"',
      'database:',
      '  <<: *db',
      '',
    ].join('\n');
    expect(parseDdevConfig(cfg)).toMatchObject({
      phpVersion: '8.3',
      dbType: 'postgres',
      dbVersion: '16',
    });
  });

  it('lets the map own key win over its merged one, and merges a list of sources in order', () => {
    const cfg = [
      'x-a: &a {type: mysql, version: "5.7"}',
      'x-b: &b {type: postgres, version: "16"}',
      'database:',
      '  <<: [*a, *b]',
      '  version: "8.0"',
      '',
    ].join('\n');
    expect(parseDdevConfig(cfg)).toMatchObject({ dbType: 'mysql', dbVersion: '8.0' });
  });

  it('reads a merged top-level field', () => {
    expect(parseDdevConfig('x: &x {php_version: "8.2"}\n<<: *x\n').phpVersion).toBe('8.2');
  });

  it('returns promptly on a 10-level alias expansion', () => {
    let cfg = 'a0: &a0 ["x","x","x","x","x","x","x","x","x"]\n';
    for (let i = 1; i < 10; i++) {
      cfg += `a${i}: &a${i} [${Array(9)
        .fill(`*a${i - 1}`)
        .join(',')}]\n`;
    }
    cfg += 'php_version: "8.3"\ndatabase: {type: *a9, version: "16"}\n';
    const started = Date.now();
    expect(parseDdevConfig(cfg)).toMatchObject({
      phpVersion: '8.3',
      dbType: null,
      dbVersion: '16',
    });
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe('ddevUrlFromConfigText', () => {
  it('derives https://<name>.ddev.site from the booted config (default tld)', () => {
    expect(ddevUrlFromConfigText(MARIADB_CONFIG)).toBe('https://myproject.ddev.site');
  });

  it('honors a custom project_tld', () => {
    const cfg = `name: myproject\nproject_tld: ddev.local\n`;
    expect(ddevUrlFromConfigText(cfg)).toBe('https://myproject.ddev.local');
  });

  it('reads a quoted name', () => {
    expect(ddevUrlFromConfigText('name: "my-app"\n')).toBe('https://my-app.ddev.site');
  });

  it('reads a quoted project_tld', () => {
    expect(ddevUrlFromConfigText('name: "my-app"\nproject_tld: "ddev.local"\n')).toBe(
      'https://my-app.ddev.local',
    );
  });

  it('returns null when name is absent (never a meaningless localhost)', () => {
    expect(ddevUrlFromConfigText('type: php\nphp_version: "8.3"\n')).toBeNull();
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

  // 01-env-detect has always READ nodejs_version; nothing wrote it, so a generated config
  // left DDEV on its own default while the declared Node version reached only the CLI
  // sandbox image. See docs/plans/patient-pinning-kernighan.md.
  it('writes the declared Node version, as a major or a full version', () => {
    expect(renderDdevConfig({ name: 'x', nodejsVersion: '22' })).toContain('nodejs_version: "22"');
    expect(renderDdevConfig({ name: 'x', nodejsVersion: '22.11.0' })).toContain(
      'nodejs_version: "22.11.0"',
    );
  });

  it('omits nodejs_version when absent, so DDEV keeps its own default', () => {
    expect(renderDdevConfig({ name: 'x', phpVersion: '8.3' })).not.toContain('nodejs_version');
    expect(renderDdevConfig({ name: 'x', nodejsVersion: null })).not.toContain('nodejs_version');
    expect(renderDdevConfig({ name: 'x', nodejsVersion: '  ' })).not.toContain('nodejs_version');
  });

  // DDEV feeds the field to nvm, which takes no ranges. `engines.node` reaches here through
  // sanitizeVersion, which strips a leading `>=` but leaves a disjunction intact -- writing
  // that would fail `ddev start`, where omitting it just means DDEV's default.
  it('omits a Node version nvm could not install rather than breaking ddev start', () => {
    for (const bad of ['20 || ^22', '^22', '>=18', 'lts/hydrogen', '22.x']) {
      expect(renderDdevConfig({ name: 'x', nodejsVersion: bad })).not.toContain('nodejs_version');
    }
  });

  // 07c compares the fields parseDdevConfig extracts; a new top-level line must not perturb
  // any of them, or an untouched environment would classify as drift.
  it('leaves every field 07c compares untouched by the new line', () => {
    const args = { name: 'x', phpVersion: '8.3', dbType: 'mariadb', dbVersion: '10.11' };
    expect(parseDdevConfig(renderDdevConfig({ ...args, nodejsVersion: '22' }))).toEqual(
      parseDdevConfig(renderDdevConfig(args)),
    );
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
