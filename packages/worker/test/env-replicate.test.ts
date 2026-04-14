import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanRepoForDeps } from '../src/step-engine/steps/env-replicate/01-declare-deps.js';
import { renderDockerfile } from '../src/step-engine/steps/env-replicate/02-generate-dockerfile.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'haive-env-replicate-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('scanRepoForDeps', () => {
  it('reports no runtimes for an empty repo', async () => {
    const result = await scanRepoForDeps(tmpRoot);
    expect(result.runtimes).toEqual([]);
    expect(result.containerTool).toBe('none');
    expect(result.database.kind).toBe('none');
    expect(result.suggestedLsp).toEqual([]);
  });

  it('detects node runtime from package.json engines', async () => {
    await writeFile(
      path.join(tmpRoot, 'package.json'),
      JSON.stringify({ name: 'test', engines: { node: '^20.11.0' } }),
    );
    const result = await scanRepoForDeps(tmpRoot);
    const node = result.runtimes.find((r) => r.language === 'node');
    expect(node?.version).toBe('20.11.0');
    expect(result.suggestedLsp).toContain('vtsls');
  });

  it('detects php runtime from composer.json require', async () => {
    await writeFile(
      path.join(tmpRoot, 'composer.json'),
      JSON.stringify({ name: 'test/app', require: { php: '>=8.2' } }),
    );
    const result = await scanRepoForDeps(tmpRoot);
    const php = result.runtimes.find((r) => r.language === 'php');
    expect(php?.version).toBe('8.2');
    expect(result.suggestedLsp).toContain('intelephense');
  });

  it('detects ddev container tool and postgres database from .ddev/config.yaml', async () => {
    await mkdir(path.join(tmpRoot, '.ddev'), { recursive: true });
    await writeFile(
      path.join(tmpRoot, '.ddev', 'config.yaml'),
      [
        'name: drupal-test',
        'type: drupal',
        'php_version: "8.3"',
        'database:',
        '  type: postgres',
        '  version: "16"',
      ].join('\n'),
    );
    const result = await scanRepoForDeps(tmpRoot);
    expect(result.containerTool).toBe('ddev');
    expect(result.ddevProjectName).toBe('drupal-test');
    expect(result.database.kind).toBe('postgres');
    expect(result.database.version).toBe('16');
    const php = result.runtimes.find((r) => r.language === 'php');
    expect(php?.version).toBe('8.3');
  });

  it('falls back to docker-compose detection when ddev is absent', async () => {
    await writeFile(
      path.join(tmpRoot, 'docker-compose.yml'),
      ['services:', '  db:', '    image: postgres:15'].join('\n'),
    );
    const result = await scanRepoForDeps(tmpRoot);
    expect(result.containerTool).toBe('docker-compose');
    expect(result.database.kind).toBe('postgres');
    expect(result.database.version).toBe('15');
  });

  it('detects go runtime from go.mod', async () => {
    await writeFile(path.join(tmpRoot, 'go.mod'), 'module example.com/test\n\ngo 1.22\n');
    const result = await scanRepoForDeps(tmpRoot);
    const go = result.runtimes.find((r) => r.language === 'go');
    expect(go?.version).toBe('1.22');
    expect(result.suggestedLsp).toContain('gopls');
  });
});

describe('renderDockerfile', () => {
  it('emits a FROM line with the base image and the base package install', () => {
    const out = renderDockerfile('ubuntu:24.04', {});
    expect(out.startsWith('FROM ubuntu:24.04\n')).toBe(true);
    expect(out).toContain('ENV DEBIAN_FRONTEND=noninteractive');
    expect(out).toContain('ca-certificates');
    expect(out).toContain('ripgrep');
    expect(out).toContain('WORKDIR /workspace');
  });

  it('adds a Node.js install block when node runtime is declared', () => {
    const out = renderDockerfile('ubuntu:24.04', {
      runtimes: ['node'],
      versions: { node: '22.4.0' },
    });
    expect(out).toContain('# Node.js 22');
    expect(out).toContain('https://deb.nodesource.com/setup_22.x');
    expect(out).toContain('npm install -g pnpm');
  });

  it('adds a PHP install block with the declared version', () => {
    const out = renderDockerfile('ddev/ddev-webserver:v1.24.0', {
      runtimes: ['php'],
      versions: { php: '8.3' },
    });
    expect(out).toContain('# PHP 8.3');
    expect(out).toContain('php8.3-cli');
    expect(out).toContain('/usr/bin/composer');
  });

  it('adds the requested LSP language servers', () => {
    const out = renderDockerfile('ubuntu:24.04', {
      runtimes: ['node', 'php'],
      lspServers: ['intelephense', 'vtsls'],
    });
    expect(out).toContain('RUN npm install -g intelephense');
    expect(out).toContain('RUN npm install -g @vtsls/language-server typescript');
  });

  it('installs chromium and chrome-devtools-mcp when browserTesting is enabled', () => {
    const out = renderDockerfile('ubuntu:24.04', { browserTesting: true });
    expect(out).toContain('# Chrome + chrome-devtools-mcp');
    expect(out).toContain('chromium');
    expect(out).toContain('chrome-devtools-mcp');
  });

  it('installs postgresql-client when a postgres database is declared', () => {
    const out = renderDockerfile('ubuntu:24.04', {
      database: { kind: 'postgres', version: '16' },
    });
    expect(out).toContain('# Database client: postgres');
    expect(out).toContain('postgresql-client');
  });

  it('appends extra system packages to the base install line', () => {
    const out = renderDockerfile('ubuntu:24.04', {
      extraPackages: ['vim', 'htop'],
    });
    expect(out).toContain('vim');
    expect(out).toContain('htop');
  });
});
