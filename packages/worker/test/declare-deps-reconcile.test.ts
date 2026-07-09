import { describe, expect, it } from 'vitest';
import {
  reconcileStaleDeps,
  type DeclareDepsFormValues,
} from '../src/step-engine/steps/env-replicate/01-declare-deps.js';
import type { DeclareDepsDetect } from '../src/step-engine/steps/env-replicate/01-declare-deps.js';

// A repo that gained a DDEV project after the task whose form values get reused.
function ddevDetect(overrides: Partial<DeclareDepsDetect> = {}): DeclareDepsDetect {
  return {
    runtimes: [
      { language: 'php', version: '8.3', source: '.ddev/config.yaml', packageManager: null },
    ],
    containerTool: 'ddev',
    webserver: 'apache-fpm',
    ddevProjectName: 'acme',
    database: { kind: 'mariadb', version: '10.11' },
    suggestedLsp: ['intelephense-extended'],
    ...overrides,
  };
}

function reusedValues(overrides: Partial<DeclareDepsFormValues> = {}): DeclareDepsFormValues {
  return {
    runtimes: ['php'],
    phpVersion: '8.3',
    containerTool: 'none',
    databaseKind: 'none',
    databaseVersion: '',
    lspServers: ['intelephense-extended'],
    preinstallDeps: true,
    browserTesting: true,
    extraPackages: '',
    ...overrides,
  };
}

describe('reconcileStaleDeps', () => {
  it('adopts a container tool the repo gained since the reused task ran', () => {
    const out = reconcileStaleDeps(ddevDetect(), reusedValues());
    expect(out.containerTool).toBe('ddev');
  });

  it('takes the detected webserver when the container tool flips to ddev', () => {
    // The prior task's `webserver` was submitted while the select was hidden, so it
    // carries no intent; apply() would otherwise default an Apache app to nginx.
    const out = reconcileStaleDeps(ddevDetect(), reusedValues({ webserver: 'nginx-fpm' }));
    expect(out.webserver).toBe('apache-fpm');
  });

  it('leaves webserver alone for a non-ddev container tool', () => {
    const detected = ddevDetect({ containerTool: 'docker-compose' });
    const out = reconcileStaleDeps(detected, reusedValues({ webserver: 'nginx-fpm' }));
    expect(out.containerTool).toBe('docker-compose');
    expect(out.webserver).toBe('nginx-fpm');
  });

  it('adopts a database the repo gained, with its version', () => {
    const out = reconcileStaleDeps(ddevDetect(), reusedValues());
    expect(out.databaseKind).toBe('mariadb');
    expect(out.databaseVersion).toBe('10.11');
  });

  it('never overwrites a container tool the user chose', () => {
    const out = reconcileStaleDeps(ddevDetect(), reusedValues({ containerTool: 'docker-compose' }));
    expect(out.containerTool).toBe('docker-compose');
    expect(out.webserver).toBeUndefined();
  });

  it('never overwrites a database the user chose', () => {
    const out = reconcileStaleDeps(
      ddevDetect(),
      reusedValues({ databaseKind: 'postgres', databaseVersion: '15' }),
    );
    expect(out.databaseKind).toBe('postgres');
    expect(out.databaseVersion).toBe('15');
  });

  it('keeps an explicitly chosen tool that has since disappeared from the repo', () => {
    const detected = ddevDetect({
      containerTool: 'none',
      database: { kind: 'none', version: null },
    });
    const out = reconcileStaleDeps(detected, reusedValues({ containerTool: 'ddev' }));
    expect(out.containerTool).toBe('ddev');
  });

  it('keeps a user-typed database version when only the kind is refreshed', () => {
    const detected = ddevDetect({ database: { kind: 'mariadb', version: '10.6' } });
    const out = reconcileStaleDeps(detected, reusedValues({ databaseVersion: '10.4' }));
    expect(out.databaseKind).toBe('mariadb');
    expect(out.databaseVersion).toBe('10.4');
  });

  it('returns the reused object untouched when nothing is stale', () => {
    const detected = ddevDetect({
      containerTool: 'none',
      database: { kind: 'none', version: null },
    });
    const reused = reusedValues();
    expect(reconcileStaleDeps(detected, reused)).toBe(reused);
  });

  it('leaves every unrelated answer intact', () => {
    const out = reconcileStaleDeps(
      ddevDetect(),
      reusedValues({ preinstallDeps: false, extraPackages: 'vim', lspServers: ['pyright'] }),
    );
    expect(out.preinstallDeps).toBe(false);
    expect(out.extraPackages).toBe('vim');
    expect(out.lspServers).toEqual(['pyright']);
  });
});
