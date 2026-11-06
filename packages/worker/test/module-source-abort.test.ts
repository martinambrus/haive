import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createDatabase, schema } from '@haive/database';
import { eq } from 'drizzle-orm';
import { secretsService } from '@haive/shared';
import { runModuleSourceFetch } from '../src/modules/source-jobs.js';
import { fetchModuleSource, sourceFetchError } from '../src/modules/source-fetch.js';

vi.mock('../src/modules/source-pin.js', () => ({
  resolveWorkerImage: async () => 'sha256:' + 'c'.repeat(64),
  pinModuleTree: vi.fn(),
}));

let scratch: string;
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

it('keeps the stored size refusal and cleans up only after an aborted git and index-pack exit', async () => {
  scratch = await mkdtemp(join(tmpdir(), 'module-abort-'));
  const childScript = join(scratch, 'index-pack.cjs');
  await writeFile(
    childScript,
    `
const fs = require('node:fs');
process.on('SIGTERM', () => setTimeout(() => {
  fs.writeFileSync('late-index-pack', 'finished');
  fs.writeFileSync(${JSON.stringify(join(scratch, 'index-pack-exited'))}, 'yes');
  process.exit(0);
}, 150));
console.log('ready');
setInterval(() => {}, 1000);
`,
  );
  await writeFile(
    join(scratch, 'git'),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('get-url')) console.log('https://example.com/alpha.git');
if (args.includes('ls-remote')) console.log('${'a'.repeat(40)}\\trefs/heads/main');
if (args.includes('fetch')) {
  const child = require('node:child_process').spawn(process.execPath, [${JSON.stringify(childScript)}]);
  fs.writeFileSync(${JSON.stringify(join(scratch, 'tree'))}, process.cwd());
  let ended = false;
  child.on('exit', () => { ended = true; });
  process.on('SIGTERM', () => {
    child.kill('SIGTERM');
    const timer = setInterval(() => {
      if (!ended) return;
      clearInterval(timer);
      fs.writeFileSync('late-git', 'finished');
      fs.writeFileSync(${JSON.stringify(join(scratch, 'git-exited'))}, 'yes');
      process.exit(0);
    }, 10);
  });
  child.stdout.once('data', () => {
    fs.mkdirSync('.git/objects/pack', { recursive: true });
    fs.writeFileSync('.git/objects/pack/tmp_pack', '');
    fs.truncateSync('.git/objects/pack/tmp_pack', 65 * 1024 * 1024);
  });
}
`,
  );
  await chmod(join(scratch, 'git'), 0o755);
  vi.stubEnv('PATH', `${scratch}:${process.env.PATH}`);
  vi.stubEnv('HAIVE_PUBLISHED_INSTALL', 'true');
  vi.stubEnv('HAIVE_OWN_MODULES_HOST_DIR', '/prepared');
  const pin = vi.fn();
  const source = {
    id: '00000000-0000-4000-8000-000000000531',
    moduleId: 'alpha',
    kind: 'git' as const,
    url: 'https://example.com/alpha.git',
    ref: 'main',
    resolvedSha: null,
  };
  const databaseUrl = process.env.MODULE_SOURCE_ABORT_TEST_URL;
  if (databaseUrl) {
    if (!new URL(databaseUrl).pathname.startsWith('/module_sources_test_abort'))
      throw new Error('Use a dedicated module_sources_test_abort database');
    const db = createDatabase(databaseUrl);
    try {
      vi.spyOn(secretsService, 'getFresh').mockResolvedValue(null);
      await db
        .insert(schema.moduleSources)
        .values({ ...source, fetchStatus: 'queued', updatedAt: new Date() });
      await expect(runModuleSourceFetch(db, source.id)).rejects.toThrow(
        'Module tree exceeds size limit',
      );
      const [failed] = await db
        .select()
        .from(schema.moduleSources)
        .where(eq(schema.moduleSources.id, source.id));
      expect(failed).toMatchObject({
        fetchStatus: 'failed',
        lastError: 'Module tree exceeds size limit',
      });
    } finally {
      await db.delete(schema.moduleSources).where(eq(schema.moduleSources.id, source.id));
      await db.$client.end({ timeout: 5 });
    }
  } else {
    let storedError = '';
    try {
      await fetchModuleSource(source, null, pin);
    } catch (error) {
      storedError = sourceFetchError(error, null);
    }
    expect(storedError).toBe('Module tree exceeds size limit');
  }
  expect(await readFile(join(scratch, 'git-exited'), 'utf8')).toBe('yes');
  expect(await readFile(join(scratch, 'index-pack-exited'), 'utf8')).toBe('yes');
  const tree = await readFile(join(scratch, 'tree'), 'utf8');
  await expect(access(join(tree, '..'))).rejects.toThrow();
  expect(pin).not.toHaveBeenCalled();
});

it('forces an aborted git to exit within a bounded wait when it ignores SIGTERM', async () => {
  scratch = await mkdtemp(join(tmpdir(), 'module-abort-stubborn-'));
  await writeFile(
    join(scratch, 'git'),
    `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(join(scratch, 'ready'))}, String(process.pid));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`,
  );
  await chmod(join(scratch, 'git'), 0o755);
  const { gitRun, GIT_NO_EXIT } = await import('../src/repo/git-exec.js');
  const controller = new AbortController();
  const run = gitRun(scratch, ['fetch'], { PATH: scratch }, { signal: controller.signal });
  await vi.waitFor(() => access(join(scratch, 'ready')));
  const pid = Number(await readFile(join(scratch, 'ready'), 'utf8'));
  const start = Date.now();
  controller.abort();
  expect(await run).toMatchObject({ code: GIT_NO_EXIT, noExit: 'ABORT_ERR' });
  expect(Date.now() - start).toBeLessThan(3000);
  expect(() => process.kill(pid, 0)).toThrow();
});
