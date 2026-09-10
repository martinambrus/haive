import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findMissingEnvFiles,
  hasExistingSpecFile,
  preflightGateSchema,
} from './_test-preflight.js';
import { buildEnumerateAllCommand } from './08b-test-management.js';

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'preflight-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function write(root: string, rel: string, body = 'x\n'): Promise<void> {
  const abs = path.join(root, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, body, 'utf8');
}

describe('findMissingEnvFiles', () => {
  it('reports a sample whose .env is absent', async () => {
    const ws = await tmp();
    await write(ws, 'test-playwright/.env.sample');

    expect(await findMissingEnvFiles(ws, ['test-playwright'])).toEqual([
      { expected: 'test-playwright/.env', sample: 'test-playwright/.env.sample' },
    ]);
  });

  it('is silent when the .env exists', async () => {
    const ws = await tmp();
    await write(ws, 'test-playwright/.env.sample');
    await write(ws, 'test-playwright/.env');

    expect(await findMissingEnvFiles(ws, ['test-playwright'])).toEqual([]);
  });

  it('is silent when no template says an .env is expected', async () => {
    const ws = await tmp();
    await write(ws, 'test-playwright/playwright.config.ts');

    expect(await findMissingEnvFiles(ws, ['test-playwright'])).toEqual([]);
  });

  it('accepts the other template spellings', async () => {
    for (const suffix of ['.example', '.dist', '.template']) {
      const ws = await tmp();
      await write(ws, `app/.env${suffix}`);
      expect(await findMissingEnvFiles(ws, ['app'])).toEqual([
        { expected: 'app/.env', sample: `app/.env${suffix}` },
      ]);
    }
  });

  it('handles the workspace root and de-dupes a repeated root', async () => {
    const ws = await tmp();
    await write(ws, '.env.sample');

    expect(await findMissingEnvFiles(ws, ['', ''])).toEqual([
      { expected: '.env', sample: '.env.sample' },
    ]);
  });
});

describe('hasExistingSpecFile', () => {
  it('finds a spec nested below the framework root', async () => {
    const ws = await tmp();
    await write(ws, 'test-playwright/tests/nested/c.test.tsx');

    expect(await hasExistingSpecFile(ws, 'test-playwright')).toBe(true);
  });

  it('ignores installed dependencies and build output', async () => {
    const ws = await tmp();
    await write(ws, 'test-playwright/node_modules/pkg/x.spec.ts');
    await write(ws, 'test-playwright/dist/y.spec.js');

    expect(await hasExistingSpecFile(ws, 'test-playwright')).toBe(false);
  });

  it('is false for a suite that does not exist yet', async () => {
    const ws = await tmp();
    await write(ws, 'test-playwright/playwright.config.ts');

    // `--list` exits non-zero for an empty project too, so without this guard the pre-flight
    // would park a repo whose tests the tester has simply not written yet.
    expect(await hasExistingSpecFile(ws, 'test-playwright')).toBe(false);
  });
});

describe('buildEnumerateAllCommand', () => {
  const opts = { ddev: true, ddevPlaywrightAddon: false, root: 'test-playwright' };

  it('passes NO file paths, so no sampled subset can decide the verdict', () => {
    // A file list drawn from the repo can consist entirely of specs that fail to load while a
    // spec outside it is fine — that would park a repo whose suite actually runs.
    const cmd = buildEnumerateAllCommand('playwright', opts);
    expect(cmd?.args).toEqual([
      'exec',
      '-d',
      '/var/www/html/test-playwright',
      'npx',
      'playwright',
      'test',
      '--list',
    ]);
    expect(cmd?.args.some((a) => a.endsWith('.ts') || a.endsWith('.js'))).toBe(false);
  });

  it('runs on the host without a ddev prefix', () => {
    expect(buildEnumerateAllCommand('playwright', { ...opts, ddev: false })).toEqual({
      kind: 'host',
      args: ['npx', 'playwright', 'test', '--list'],
      cwd: 'test-playwright',
    });
  });

  it('declines the frameworks and shapes it has not measured', () => {
    expect(buildEnumerateAllCommand('vitest', opts)).toBeNull();
    expect(buildEnumerateAllCommand(null, opts)).toBeNull();
    // The addon's flag pass-through is unmeasured — same guard buildCollectCommand states.
    expect(
      buildEnumerateAllCommand('playwright', { ...opts, ddevPlaywrightAddon: true }),
    ).toBeNull();
    // null root = no config file found anywhere.
    expect(buildEnumerateAllCommand('playwright', { ...opts, root: null })).toBeNull();
  });
});

describe('preflightGateSchema', () => {
  const block = {
    command: 'ddev exec -d /var/www/html/test-playwright npx playwright test --list a.spec.ts',
    output: 'Total: 0 tests in 0 files\nError: COMMON_DATA env variable not defined\n',
    missing: [{ expected: 'test-playwright/.env', sample: 'test-playwright/.env.sample' }],
  };

  it('is a retry schema, so auto-continue cannot answer it', () => {
    // step-runner's auto-submit is gated on `submitAction === 'submit'`; anything else parks.
    expect(preflightGateSchema(block).submitAction).toBe('retry');
  });

  it('carries no fields, since the fix is made outside Haive', () => {
    expect(preflightGateSchema(block).fields).toEqual([]);
  });

  it('names the missing file and quotes the command that proved it', () => {
    const body = preflightGateSchema(block).description ?? '';
    expect(body).toContain('test-playwright/.env');
    expect(body).toContain('test-playwright/.env.sample');
    expect(body).toContain(block.command);
    expect(body).toContain('COMMON_DATA env variable not defined');
  });

  it('renders without a missing-file section when the hint named none', () => {
    const body = preflightGateSchema({ ...block, missing: [] }).description ?? '';
    expect(body).not.toContain('Missing environment files');
    expect(body).toContain(block.command);
  });
});
