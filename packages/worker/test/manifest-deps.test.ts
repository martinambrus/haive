import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import {
  collectExtraManifestDeps,
  detectLanguageRuntimes,
  firstMajor,
  manifestPackages,
  numericVersion,
  parseCargoToml,
  parseComposerDeps,
  parseGemfile,
  parseGemfileLock,
  parseGoMod,
  parseGoVersion,
  parsePackageJsonDeps,
  parsePyprojectDeps,
  parsePythonVersion,
  parseRequirementsTxt,
  parseRubyVersion,
  parseRustVersion,
  parseWorkspaceGlobs,
} from '../src/step-engine/steps/onboarding/_manifest-deps.js';

describe('firstMajor', () => {
  it('takes the leading integer of a constraint', () => {
    expect(firstMajor('^11.0')).toBe('11');
    expect(firstMajor('~10.3')).toBe('10');
    expect(firstMajor('>=9.5 <11')).toBe('9');
    expect(firstMajor('v2.3.4')).toBe('2');
    expect(firstMajor('')).toBeNull();
    expect(firstMajor(undefined)).toBeNull();
    expect(firstMajor('*')).toBeNull();
  });
});

describe('manifestPackages', () => {
  it('reduces to deduped name@major and skips platform reqs', () => {
    const out = manifestPackages([
      ['next', '^16.1.0'],
      ['react', '^19.0.0'],
      ['next', '16.2.0'], // dup name@major -> dropped
      ['php', '^8.2'], // platform -> skipped
      ['ext-gd', '*'], // platform -> skipped
      ['lib-curl', '*'], // platform -> skipped
      ['no-version', '*'], // no major -> skipped
      ['drupal/views', '^3.0'],
    ]);
    expect(out).toEqual(['next@16', 'react@19', 'drupal/views@3']);
  });
});

describe('parsePackageJsonDeps / parseComposerDeps', () => {
  it('reads deps + devDeps from package.json', () => {
    const text = JSON.stringify({
      dependencies: { next: '^16.0.0' },
      devDependencies: { vitest: '^3.2.0' },
    });
    expect(parsePackageJsonDeps(text)).toEqual([
      ['next', '^16.0.0'],
      ['vitest', '^3.2.0'],
    ]);
    expect(parsePackageJsonDeps('not json')).toEqual([]);
  });

  it('reads require + require-dev from composer.json', () => {
    const text = JSON.stringify({
      require: { 'drupal/core': '^11.0', php: '^8.3' },
      'require-dev': { 'drupal/coder': '^8.3' },
    });
    expect(parseComposerDeps(text)).toEqual([
      ['drupal/core', '^11.0'],
      ['php', '^8.3'],
      ['drupal/coder', '^8.3'],
    ]);
  });
});

describe('parseWorkspaceGlobs', () => {
  it('parses pnpm-workspace.yaml packages list', () => {
    const yaml = ['packages:', '  - "packages/*"', '  - "apps/*"', '  - "!**/test/**"'].join('\n');
    expect(parseWorkspaceGlobs(yaml, null)).toEqual(['packages/*', 'apps/*']);
  });

  it('parses package.json workspaces (array and object forms) and drops negations', () => {
    expect(parseWorkspaceGlobs(null, JSON.stringify({ workspaces: ['packages/*'] }))).toEqual([
      'packages/*',
    ]);
    expect(
      parseWorkspaceGlobs(
        null,
        JSON.stringify({ workspaces: { packages: ['libs/*', '!libs/x'] } }),
      ),
    ).toEqual(['libs/*']);
  });

  it('stops the pnpm list at the next top-level key', () => {
    const yaml = ['packages:', '  - "packages/*"', 'catalog:', '  react: ^19'].join('\n');
    expect(parseWorkspaceGlobs(yaml, null)).toEqual(['packages/*']);
  });
});

describe('parseGemfile / parseGemfileLock', () => {
  it('reads direct gems with optional inline versions', () => {
    const gemfile = ["gem 'rails', '~> 7.1.0'", 'gem "pg"', "gem 'devise', '>= 4.9'"].join('\n');
    expect(parseGemfile(gemfile)).toEqual([
      ['rails', '~> 7.1.0'],
      ['pg', ''],
      ['devise', '>= 4.9'],
    ]);
  });

  it('reads resolved top-level specs from a lockfile', () => {
    const lock = [
      'GEM',
      '  remote: https://rubygems.org/',
      '  specs:',
      '    rails (7.1.0)',
      '    pg (1.5.4)',
      '      activerecord (= 7.1.0)', // 6-space sub-dep -> ignored
    ].join('\n');
    expect(parseGemfileLock(lock)).toEqual([
      ['rails', '7.1.0'],
      ['pg', '1.5.4'],
    ]);
  });
});

describe('parseRequirementsTxt', () => {
  it('reads pinned requirements and skips comments/flags/unpinned', () => {
    const text = [
      '# comment',
      '-r base.txt',
      'Django==5.0.1',
      'requests>=2.31.0',
      'numpy~=1.26',
      'uvicorn[standard]==0.30.0',
      'unpinned-pkg',
    ].join('\n');
    expect(parseRequirementsTxt(text)).toEqual([
      ['Django', '5.0.1'],
      ['requests', '2.31.0'],
      ['numpy', '1.26'],
      ['uvicorn', '0.30.0'],
    ]);
  });
});

describe('parsePyprojectDeps', () => {
  it('reads PEP 621 dependencies array', () => {
    const text = [
      '[project]',
      'dependencies = [',
      '  "Django>=5.0",',
      '  "requests==2.31.0",',
      ']',
    ].join('\n');
    expect(parsePyprojectDeps(text)).toEqual([
      ['Django', '5.0'],
      ['requests', '2.31.0'],
    ]);
  });

  it('reads Poetry dependencies and drops the python pin', () => {
    const text = [
      '[tool.poetry.dependencies]',
      'python = "^3.12"',
      'django = "^5.0"',
      'httpx = "0.27.0"',
      '[tool.poetry.dev-dependencies]',
    ].join('\n');
    expect(parsePyprojectDeps(text)).toEqual([
      ['django', '^5.0'],
      ['httpx', '0.27.0'],
    ]);
  });
});

describe('parseGoMod', () => {
  it('reads require blocks and single lines, skipping indirect', () => {
    const text = [
      'module example.com/app',
      'go 1.22',
      'require (',
      '  github.com/gin-gonic/gin v1.9.1',
      '  github.com/foo/bar v2.3.4 // indirect',
      ')',
      'require github.com/single/dep v1.0.0',
    ].join('\n');
    expect(parseGoMod(text)).toEqual([
      ['github.com/gin-gonic/gin', '1.9.1'],
      ['github.com/single/dep', '1.0.0'],
    ]);
  });
});

describe('parseCargoToml', () => {
  it('reads string and table dependency forms', () => {
    const text = [
      '[dependencies]',
      'serde = "1.0"',
      'tokio = { version = "1.35", features = ["full"] }',
      '[dev-dependencies]',
      'criterion = "0.5"',
    ].join('\n');
    expect(parseCargoToml(text)).toEqual([
      ['serde', '1.0'],
      ['tokio', '1.35'],
      ['criterion', '0.5'],
    ]);
  });
});

describe('runtime version parsers', () => {
  it('numericVersion keeps minor/patch', () => {
    expect(numericVersion('>=24.0.0')).toBe('24.0.0');
    expect(numericVersion('^3.12')).toBe('3.12');
    expect(numericVersion('v20')).toBe('20');
    expect(numericVersion('lts/iron')).toBeNull();
  });

  it('parseGoVersion reads the go directive', () => {
    expect(parseGoVersion('module x\n\ngo 1.22\n')).toBe('1.22');
    expect(parseGoVersion('go 1.21.5')).toBe('1.21.5');
    expect(parseGoVersion('module x')).toBeNull();
  });

  it('parseRustVersion reads rust-version (MSRV)', () => {
    expect(parseRustVersion('[package]\nname = "x"\nrust-version = "1.75"\n')).toBe('1.75');
    expect(parseRustVersion('[package]\nname = "x"\n')).toBeNull();
  });

  it('parsePythonVersion reads requires-python or poetry python pin', () => {
    expect(parsePythonVersion('[project]\nrequires-python = ">=3.11"\n')).toBe('3.11');
    expect(parsePythonVersion('[tool.poetry.dependencies]\npython = "^3.12"\n')).toBe('3.12');
    expect(parsePythonVersion('[project]\nname = "x"\n')).toBeNull();
  });

  it('parseRubyVersion reads the ruby directive', () => {
    expect(parseRubyVersion("source 'x'\nruby '3.3.0'\n")).toBe('3.3.0');
    expect(parseRubyVersion('gem "rails"')).toBeNull();
  });
});

describe('collectExtraManifestDeps (pnpm monorepo)', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'haive-manifest-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('collects deps from every workspace package.json via pnpm-workspace.yaml', async () => {
    await writeFile(path.join(tmp, 'package.json'), JSON.stringify({ name: 'root' }));
    await writeFile(path.join(tmp, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    await mkdir(path.join(tmp, 'packages', 'web'), { recursive: true });
    await mkdir(path.join(tmp, 'packages', 'api'), { recursive: true });
    await writeFile(
      path.join(tmp, 'packages', 'web', 'package.json'),
      JSON.stringify({ dependencies: { next: '^16.1.0', react: '^19.0.0' } }),
    );
    await writeFile(
      path.join(tmp, 'packages', 'api', 'package.json'),
      JSON.stringify({ dependencies: { hono: '^4.6.0' } }),
    );

    const deps = await collectExtraManifestDeps(tmp);
    const tokens = manifestPackages(deps);
    expect(tokens).toContain('next@16');
    expect(tokens).toContain('react@19');
    expect(tokens).toContain('hono@4');
  });

  it('returns nothing for a plain repo with no extra manifests', async () => {
    await writeFile(path.join(tmp, 'package.json'), JSON.stringify({ name: 'solo' }));
    expect(await collectExtraManifestDeps(tmp)).toEqual([]);
  });

  it('detectLanguageRuntimes reads go/rust/python/ruby versions from disk', async () => {
    await writeFile(path.join(tmp, 'go.mod'), 'module x\n\ngo 1.22\n');
    await writeFile(path.join(tmp, 'Cargo.toml'), '[package]\nrust-version = "1.75"\n');
    await writeFile(path.join(tmp, '.python-version'), '3.12.1\n');
    await writeFile(path.join(tmp, '.ruby-version'), '3.3.0\n');
    expect(await detectLanguageRuntimes(tmp)).toEqual({
      go: '1.22',
      rust: '1.75',
      python: '3.12.1',
      ruby: '3.3.0',
    });
  });
});
