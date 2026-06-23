import { describe, it, expect } from 'vitest';
import { classifyDrift, ddevReconcileStep } from './07c-ddev-reconcile.js';
import { parseDdevProjectListForApproot } from '../../../sandbox/ddev-runner.js';
import type { DdevConfigFields } from '../_ddev-config.js';
import type { DdevBaseline } from './01c-ddev-env.js';

describe('07c-ddev-reconcile form', () => {
  const detect = (driftKind: string, migrateTarget: string | null = null) =>
    ({
      repoSubpath: 'x',
      workspace: '/w',
      baseline: null,
      target: null,
      driftKind,
      migrateTarget,
      unsupportedReason: null,
    }) as never;

  it('restart + no-op auto-submit (nothing to decide; flows through even in manual mode)', () => {
    for (const kind of ['restart', 'none']) {
      const s = ddevReconcileStep.form!(undefined as never, detect(kind));
      expect(s).not.toBeNull();
      expect(s!.fields).toHaveLength(0);
      expect(s!.autoSubmit).toBe(true);
    }
  });

  it('db-migrate gates with a confirm checkbox (no auto-submit)', () => {
    const s = ddevReconcileStep.form!(undefined as never, detect('db-migrate', 'mysql:8.0'));
    expect(s).not.toBeNull();
    expect(s!.autoSubmit).toBeUndefined();
    expect(s!.fields.find((f) => f.id === 'confirmDbMigration')).toBeDefined();
  });

  it('unsupported renders no form (apply throws the reason)', () => {
    expect(ddevReconcileStep.form!(undefined as never, detect('unsupported'))).toBeNull();
  });
});

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

describe('parseDdevProjectListForApproot (Slice C name-drift detection)', () => {
  // The registry retains the OLD name (rs-ollama9) after the config was renamed to calypso —
  // exactly the drift that must trigger a rename. Mirrors a real ~/.ddev/project_list.yaml.
  const registry = [
    'rs-ollama9:',
    '    approot: /repos/u/r/.haive/worktrees/feature-add-ddev-environment',
    'other:',
    '    approot: /repos/u/other',
    '',
  ].join('\n');

  it('returns the REGISTERED name for the approot (old name after a config rename)', () => {
    expect(
      parseDdevProjectListForApproot(
        registry,
        '/repos/u/r/.haive/worktrees/feature-add-ddev-environment',
      ),
    ).toBe('rs-ollama9');
  });

  it('matches a later entry too', () => {
    expect(parseDdevProjectListForApproot(registry, '/repos/u/other')).toBe('other');
  });

  it('returns null when no entry matches the approot', () => {
    expect(parseDdevProjectListForApproot(registry, '/repos/u/nope')).toBeNull();
  });

  it('returns null on an empty/missing registry', () => {
    expect(parseDdevProjectListForApproot('', '/x')).toBeNull();
  });
});
