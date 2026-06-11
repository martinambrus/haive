import { describe, it, expect } from 'vitest';
import { classifyDrift } from './07c-ddev-reconcile.js';
import type { DdevConfigFields } from '../_ddev-config.js';
import type { DdevBaseline } from './01c-ddev-env.js';

const HASH_A = 'hash-a';
const HASH_B = 'hash-b';

function baseline(over: Partial<DdevBaseline> = {}): DdevBaseline {
  return { phpVersion: '8.1', dbType: 'mariadb', dbVersion: '10.4', configHash: HASH_A, ...over };
}
function target(over: Partial<DdevConfigFields> = {}): DdevConfigFields {
  return {
    phpVersion: '8.1',
    dbType: 'mariadb',
    dbVersion: '10.4',
    webserver: 'nginx-fpm',
    docroot: 'web',
    ...over,
  };
}

describe('classifyDrift', () => {
  it('no change (same db, same hash) -> none', () => {
    expect(classifyDrift(baseline(), target(), HASH_A).kind).toBe('none');
  });

  it('php-only bump (db same, hash differs) -> restart', () => {
    const r = classifyDrift(baseline(), target({ phpVersion: '8.3' }), HASH_B);
    expect(r.kind).toBe('restart');
    expect(r.migrateTarget).toBeNull();
  });

  it('non-db config change (webserver) -> restart', () => {
    expect(classifyDrift(baseline(), target({ webserver: 'apache-fpm' }), HASH_B).kind).toBe(
      'restart',
    );
  });

  it('db version bump (mariadb 10.4 -> 11.4) -> db-migrate', () => {
    const r = classifyDrift(baseline(), target({ dbVersion: '11.4' }), HASH_B);
    expect(r.kind).toBe('db-migrate');
    expect(r.migrateTarget).toBe('mariadb:11.4');
  });

  it('db type change (mariadb -> mysql) -> db-migrate', () => {
    const r = classifyDrift(baseline(), target({ dbType: 'mysql', dbVersion: '8.0' }), HASH_B);
    expect(r.kind).toBe('db-migrate');
    expect(r.migrateTarget).toBe('mysql:8.0');
  });

  it('null baseline db (ddev default) + explicit target -> db-migrate', () => {
    const r = classifyDrift(
      baseline({ dbType: null, dbVersion: null }),
      target({ dbType: 'mariadb', dbVersion: '11.4' }),
      HASH_B,
    );
    expect(r.kind).toBe('db-migrate');
    expect(r.migrateTarget).toBe('mariadb:11.4');
  });

  it('target postgres -> unsupported', () => {
    const r = classifyDrift(baseline(), target({ dbType: 'postgres', dbVersion: '16' }), HASH_B);
    expect(r.kind).toBe('unsupported');
    expect(r.unsupportedReason).toContain('PostgreSQL');
    expect(r.migrateTarget).toBeNull();
  });

  it('baseline postgres -> unsupported', () => {
    const r = classifyDrift(
      baseline({ dbType: 'postgres', dbVersion: '15' }),
      target({ dbType: 'mysql', dbVersion: '8.0' }),
      HASH_B,
    );
    expect(r.kind).toBe('unsupported');
  });
});
