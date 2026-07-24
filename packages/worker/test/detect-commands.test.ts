import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectCommandsForTest } from '../src/step-engine/steps/onboarding/01-env-detect.js';
import { projectInfoMarkdown } from '../src/step-engine/steps/onboarding/07-generate-files.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'haive-cmd-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('detectCommands', () => {
  it('keeps conventional scripts and drops the rest', async () => {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        scripts: {
          build: 'tsc',
          'test:unit': 'vitest',
          lint: 'eslint .',
          // Neither is a command an agent needs to verify its work.
          postinstall: 'node scripts/patch.js',
          'release:publish': 'npm publish',
        },
      }),
    );
    expect(await detectCommandsForTest(dir)).toEqual([
      'npm run build',
      'npm run test:unit',
      'npm run lint',
    ]);
  });

  it('uses the package manager the lockfile implies', async () => {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest' } }),
    );
    await writeFile(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    expect(await detectCommandsForTest(dir)).toEqual(['pnpm run test']);
  });

  it('reads composer scripts and Makefile targets', async () => {
    await writeFile(
      path.join(dir, 'composer.json'),
      JSON.stringify({
        scripts: { test: 'phpunit', 'lint:php': 'phpcs', 'post-install-cmd': 'x' },
      }),
    );
    await writeFile(
      path.join(dir, 'Makefile'),
      [
        '.PHONY: build test',
        'CFLAGS := -O2',
        'build:',
        '\techo building',
        'deploy:',
        '\techo deploying',
        '%.o: %.c',
        '\techo pattern',
      ].join('\n'),
    );
    const commands = await detectCommandsForTest(dir);
    expect(commands).toContain('composer test');
    expect(commands).toContain('composer lint:php');
    expect(commands).toContain('make build');
    // `deploy` is not a verification command; `.PHONY`, the variable assignment
    // and the pattern rule are not targets a developer runs.
    expect(commands).not.toContain('composer post-install-cmd');
    expect(commands).not.toContain('make deploy');
    expect(commands.some((c) => c.includes('PHONY') || c.includes('CFLAGS'))).toBe(false);
    expect(commands.some((c) => c.includes('%'))).toBe(false);
  });

  it('returns nothing for a repo with no manifests, and survives a broken one', async () => {
    expect(await detectCommandsForTest(dir)).toEqual([]);
    await writeFile(path.join(dir, 'package.json'), '{ not json');
    expect(await detectCommandsForTest(dir)).toEqual([]);
  });
});

describe('projectInfoMarkdown commands block', () => {
  const base = {
    name: 'x',
    framework: null,
    primaryLanguage: null,
    description: null,
    localUrl: null,
    databaseType: null,
    databaseVersion: null,
    webserver: null,
    docroot: null,
    runtimeVersions: {},
    testFrameworks: [],
    testPaths: [],
    buildTool: null,
    containerType: null,
  };

  it('omits the heading entirely when nothing was detected', () => {
    expect(projectInfoMarkdown({ ...base, commands: [] })).not.toContain('## Commands');
  });

  it('renders each detected command as its own code-fenced bullet', () => {
    const md = projectInfoMarkdown({ ...base, commands: ['pnpm run test', 'make build'] });
    expect(md).toContain('## Commands');
    expect(md).toContain('- `pnpm run test`');
    expect(md).toContain('- `make build`');
  });
});
