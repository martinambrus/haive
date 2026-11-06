import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { GIT_NO_EXIT, GIT_TIMED_OUT, gitRun } from '../src/repo/git-exec.js';

let scratch: string;
const survivors: number[] = [];

afterEach(async () => {
  for (const pid of survivors.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* Already exited. */
    }
  }
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

it('bounds a signal-enabled timeout even when a setsid holder keeps its pipes open', async () => {
  scratch = await mkdtemp(join(tmpdir(), 'git-outside-pipes-'));
  const marker = join(scratch, 'holder-pid');
  await writeFile(
    join(scratch, 'git'),
    `#!${process.execPath}
require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(`
require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));
setTimeout(() => {}, 6000);
`)}], { detached: true, stdio: 'inherit' });
setInterval(() => {}, 1000);
`,
  );
  await chmod(join(scratch, 'git'), 0o755);
  const controller = new AbortController();
  const start = Date.now();
  const run = gitRun(
    scratch,
    ['fetch'],
    { PATH: scratch },
    { signal: controller.signal, timeout: 1500 },
  );
  const pid = await vi.waitFor(async () => Number(await readFile(marker, 'utf8')));
  survivors.push(pid);
  expect(await run).toMatchObject({ code: GIT_TIMED_OUT });
  expect(Date.now() - start).toBeLessThan(4000);
  // This process left git's group, so gitRun must stop waiting for its pipes.
  expect(() => process.kill(pid, 0)).not.toThrow();
  expect(controller.signal.aborted).toBe(false);
});

it('stops and awaits the whole signal-enabled group after output overflows', async () => {
  scratch = await mkdtemp(join(tmpdir(), 'git-overflow-group-'));
  const marker = join(scratch, 'child-pid');
  const exited = join(scratch, 'child-exited');
  await writeFile(
    join(scratch, 'git'),
    `#!${process.execPath}
require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(`
const fs = require('node:fs');
process.on('SIGTERM', () => setTimeout(() => {
  fs.writeFileSync(${JSON.stringify(exited)}, 'yes');
  process.exit(0);
}, 150));
fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));
console.log('x'.repeat(8192));
setInterval(() => {}, 1000);
`)}], { stdio: 'inherit' });
setInterval(() => {}, 1000);
`,
  );
  await chmod(join(scratch, 'git'), 0o755);
  const controller = new AbortController();
  const run = gitRun(
    scratch,
    ['fetch'],
    { PATH: scratch },
    { signal: controller.signal, maxBuffer: 32, timeout: 0 },
  );
  const pid = await vi.waitFor(async () => Number(await readFile(marker, 'utf8')));
  survivors.push(pid);
  expect(await run).toMatchObject({
    code: GIT_NO_EXIT,
    noExit: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
  });
  expect(await readFile(exited, 'utf8')).toBe('yes');
  expect(() => process.kill(pid, 0)).toThrow();
  expect(controller.signal.aborted).toBe(false);
});

it.each(['stdout', 'stderr'] as const)(
  'keeps exactly maxBuffer bytes of partial %s when a chunk crosses the limit',
  async (stream) => {
    scratch = await mkdtemp(join(tmpdir(), 'git-overflow-output-'));
    await writeFile(
      join(scratch, 'git'),
      `#!${process.execPath}\nprocess.${stream}.write('x'.repeat(8192));\n`,
    );
    await chmod(join(scratch, 'git'), 0o755);
    const result = await gitRun(scratch, ['fetch'], { PATH: scratch }, { maxBuffer: 32 });
    expect(result).toMatchObject({
      code: GIT_NO_EXIT,
      noExit: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    });
    const partial = stream === 'stdout' ? result.stdout : result.stderr.split('\n')[0];
    expect(partial).toBe('x'.repeat(32));
    expect(Buffer.byteLength(partial!)).toBe(32);
  },
);
