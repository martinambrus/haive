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
    expect(go?.packageManager).toBe('gomod');
  });

  it('detects rust runtime and cargo package manager from Cargo.toml', async () => {
    await writeFile(
      path.join(tmpRoot, 'Cargo.toml'),
      '[package]\nname = "test"\nrust-version = "1.78"\n',
    );
    const result = await scanRepoForDeps(tmpRoot);
    const rust = result.runtimes.find((r) => r.language === 'rust');
    expect(rust?.version).toBe('1.78');
    expect(rust?.packageManager).toBe('cargo');
    expect(result.suggestedLsp).toContain('rust-analyzer');
  });

  it('detects ruby runtime and bundler package manager from Gemfile', async () => {
    await writeFile(path.join(tmpRoot, 'Gemfile'), "source 'https://rubygems.org'\nruby '3.3.0'\n");
    const result = await scanRepoForDeps(tmpRoot);
    const ruby = result.runtimes.find((r) => r.language === 'ruby');
    expect(ruby?.version).toBe('3.3.0');
    expect(ruby?.packageManager).toBe('bundler');
    expect(result.suggestedLsp).toContain('solargraph');
  });

  it('detects pnpm when pnpm-lock.yaml is present', async () => {
    await writeFile(path.join(tmpRoot, 'package.json'), JSON.stringify({ name: 'test' }));
    await writeFile(path.join(tmpRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    const result = await scanRepoForDeps(tmpRoot);
    const node = result.runtimes.find((r) => r.language === 'node');
    expect(node?.packageManager).toBe('pnpm');
  });

  it('detects yarn when yarn.lock is present', async () => {
    await writeFile(path.join(tmpRoot, 'package.json'), JSON.stringify({ name: 'test' }));
    await writeFile(path.join(tmpRoot, 'yarn.lock'), '# yarn lockfile v1\n');
    const result = await scanRepoForDeps(tmpRoot);
    const node = result.runtimes.find((r) => r.language === 'node');
    expect(node?.packageManager).toBe('yarn');
  });

  it('detects bun when bun.lockb is present and wins over pnpm-lock.yaml', async () => {
    await writeFile(path.join(tmpRoot, 'package.json'), JSON.stringify({ name: 'test' }));
    await writeFile(path.join(tmpRoot, 'bun.lockb'), '');
    await writeFile(path.join(tmpRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    const result = await scanRepoForDeps(tmpRoot);
    const node = result.runtimes.find((r) => r.language === 'node');
    expect(node?.packageManager).toBe('bun');
  });

  it('defaults the node package manager to npm when no lockfile is present', async () => {
    await writeFile(path.join(tmpRoot, 'package.json'), JSON.stringify({ name: 'test' }));
    const result = await scanRepoForDeps(tmpRoot);
    const node = result.runtimes.find((r) => r.language === 'node');
    expect(node?.packageManager).toBe('npm');
  });

  it('detects uv when uv.lock is present and wins over poetry', async () => {
    await writeFile(
      path.join(tmpRoot, 'pyproject.toml'),
      '[project]\nname = "test"\nversion = "0.1.0"\n',
    );
    await writeFile(path.join(tmpRoot, 'uv.lock'), 'version = 1\n');
    await writeFile(path.join(tmpRoot, 'poetry.lock'), '# poetry lockfile\n');
    const result = await scanRepoForDeps(tmpRoot);
    const python = result.runtimes.find((r) => r.language === 'python');
    expect(python?.packageManager).toBe('uv');
  });

  it('detects poetry when poetry.lock is present', async () => {
    await writeFile(
      path.join(tmpRoot, 'pyproject.toml'),
      '[tool.poetry]\nname = "test"\nversion = "0.1.0"\n',
    );
    await writeFile(path.join(tmpRoot, 'poetry.lock'), '# poetry lockfile\n');
    const result = await scanRepoForDeps(tmpRoot);
    const python = result.runtimes.find((r) => r.language === 'python');
    expect(python?.packageManager).toBe('poetry');
  });

  it('detects pdm when pdm.lock is present', async () => {
    await writeFile(
      path.join(tmpRoot, 'pyproject.toml'),
      '[project]\nname = "test"\nversion = "0.1.0"\n',
    );
    await writeFile(path.join(tmpRoot, 'pdm.lock'), '# pdm lockfile\n');
    const result = await scanRepoForDeps(tmpRoot);
    const python = result.runtimes.find((r) => r.language === 'python');
    expect(python?.packageManager).toBe('pdm');
  });

  it('detects pipenv when Pipfile.lock is present', async () => {
    await writeFile(path.join(tmpRoot, 'requirements.txt'), 'requests==2.31.0\n');
    await writeFile(path.join(tmpRoot, 'Pipfile.lock'), '{}');
    const result = await scanRepoForDeps(tmpRoot);
    const python = result.runtimes.find((r) => r.language === 'python');
    expect(python?.packageManager).toBe('pipenv');
  });

  it('defaults the python package manager to pip when only requirements.txt is present', async () => {
    await writeFile(path.join(tmpRoot, 'requirements.txt'), 'requests==2.31.0\n');
    const result = await scanRepoForDeps(tmpRoot);
    const python = result.runtimes.find((r) => r.language === 'python');
    expect(python?.packageManager).toBe('pip');
  });

  it('detects composer as the php package manager from composer.json', async () => {
    await writeFile(
      path.join(tmpRoot, 'composer.json'),
      JSON.stringify({ name: 'test/app', require: { php: '>=8.2' } }),
    );
    const result = await scanRepoForDeps(tmpRoot);
    const php = result.runtimes.find((r) => r.language === 'php');
    expect(php?.packageManager).toBe('composer');
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
    expect(out).toContain('corepack enable');
    expect(out).toContain('build-essential');
    expect(out).toContain('python3');
    expect(out).toContain('pkg-config');
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
