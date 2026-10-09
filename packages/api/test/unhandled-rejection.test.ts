import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

const MESSAGE = 'unhandled promise rejection (api kept alive)';
const REASON = 'connection lost during the type fetch';
const seam = () => import('../src/lib/unhandled-rejection.js');
const seamUrl = new URL('../src/lib/unhandled-rejection.ts', import.meta.url).href;

afterEach(() => vi.restoreAllMocks());

describe('installUnhandledRejectionLogger', () => {
  it('logs the reason at error level and leaves the process running', async () => {
    const { installUnhandledRejectionLogger } = await seam();
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const proc = new EventEmitter();
    const log = { error: vi.fn() };
    installUnhandledRejectionLogger(proc, log);
    const reason = new Error(REASON);

    proc.emit('unhandledRejection', reason, Promise.resolve());

    expect(proc.listenerCount('unhandledRejection')).toBe(1);
    expect(log.error).toHaveBeenCalledExactlyOnceWith({ err: reason }, MESSAGE);
    expect(exit).not.toHaveBeenCalled();
  }, 30_000);

  it('is installed by the api entry before the server starts', () => {
    const entry = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const installed = entry.indexOf('installUnhandledRejectionLogger();');
    expect(installed).toBeGreaterThan(-1);
    expect(installed).toBeLessThan(entry.indexOf('main().catch('));
  });
});

describe('a rejection nobody awaits, in a real process', () => {
  async function run(install: boolean) {
    const script = `
      ${install ? `(await import(${JSON.stringify(seamUrl)})).installUnhandledRejectionLogger();` : ''}
      void Promise.reject(new Error(${JSON.stringify(REASON)}));
      await new Promise((resolve) => setTimeout(resolve, 200));
      process.stdout.write('still running\\n');
    `;
    try {
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', script],
        {
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          env: { ...process.env, LOG_LEVEL: 'info' },
          timeout: 30_000,
        },
      );
      return { code: 0, stdout, stderr };
    } catch (err) {
      return err as { code: number | undefined; stdout: string; stderr: string };
    }
  }

  it('ends a process that has no listener (control)', async () => {
    const out = await run(false);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain(REASON);
    expect(out.stdout).not.toContain('still running');
  }, 30_000);

  it('is logged at error level and survived once the logger is installed', async () => {
    const out = await run(true);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('still running');
    const logged = out.stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as unknown);
    expect(logged).toContainEqual(
      expect.objectContaining({
        level: 50,
        msg: MESSAGE,
        err: expect.objectContaining({ message: REASON }),
      }),
    );
  }, 30_000);
});
