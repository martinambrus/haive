import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseReleaseManifest } from '@haive/shared/release';
import * as dk from './docker.js';
import { VERSION_WAIT_TIMEOUT_MS, phaseVerify, type UpgradeContext } from './run.js';

describe('the version health gate deadline', () => {
  let dir: string;
  let ctx: UpgradeContext;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'version-wait-'));
    await writeFile(join(dir, '.env'), 'HAIVE_VERSION=1.0.0\n');
    ctx = {
      sql: vi.fn(async () => []),
      runId: 'run',
      compose: { dir, files: [] },
      envFile: join(dir, '.env'),
      target: parseReleaseManifest({
        manifestVersion: 1,
        version: '1.1.0',
        builtAt: '2026-11-27',
        migrationHead: '0250',
      }),
      apiUrl: 'http://api.test',
      versionWaitTimeoutMs: 40,
      log: vi.fn(),
    } as unknown as UpgradeContext;
    vi.spyOn(dk, 'composeUp').mockResolvedValue(undefined);
  });

  it('retains the three-minute production startup allowance', () => {
    expect(VERSION_WAIT_TIMEOUT_MS).toBe(180_000);
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  it.each(['headers', 'body'])(
    'fails verification at the deadline with stalled %s and aborts the request',
    async (stall) => {
      vi.useFakeTimers();
      let began!: () => void;
      const started = new Promise<void>((resolve) => (began = resolve));
      let signal: AbortSignal | undefined;
      vi.stubGlobal(
        'fetch',
        vi.fn((_url, init) => {
          signal = init?.signal;
          if (stall === 'headers') {
            began();
            return new Promise(() => {});
          }
          return Promise.resolve({
            ok: true,
            json: () => {
              began();
              return new Promise(() => {});
            },
          });
        }),
      );
      const waiting = phaseVerify(ctx);
      let settled = false;
      void waiting.then(() => (settled = true));
      await started;
      await vi.advanceTimersByTimeAsync(39);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(await waiting).toBe(false);
      expect(signal?.aborted).toBe(true);
      expect(signal?.reason).toBeInstanceOf(DOMException);
      expect(signal?.reason.name).toBe('TimeoutError');
      expect(ctx.log).toHaveBeenCalledWith('verify-timeout', {
        expected: '1.1.0',
        expectedHead: '0250',
        saw: undefined,
        head: undefined,
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('accepts the matching version and head with the default limit and clears its timer', async () => {
    vi.useFakeTimers();
    delete ctx.versionWaitTimeoutMs;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ version: '1.1.0', migrationHead: '0250' }))),
    );
    expect(await phaseVerify(ctx)).toBe(true);
    expect(ctx.log).toHaveBeenCalledWith('verified', { version: '1.1.0', head: '0250' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { version: '1.0.0', migrationHead: '0250' },
    { version: '1.1.0', migrationHead: '0249' },
  ])('rejects a mismatching version or head: %j', async (body) => {
    vi.useFakeTimers();
    let began!: () => void;
    const started = new Promise<void>((resolve) => (began = resolve));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        began();
        return new Response(JSON.stringify(body));
      }),
    );
    const waiting = phaseVerify(ctx);
    await started;
    await vi.advanceTimersByTimeAsync(40);
    expect(await waiting).toBe(false);
    expect(ctx.log).toHaveBeenCalledWith('verify-timeout', {
      expected: '1.1.0',
      expectedHead: '0250',
      saw: body.version,
      head: body.migrationHead,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps one total budget across retries and ignores a late successful body', async () => {
    vi.useFakeTimers();
    ctx.versionWaitTimeoutMs = 2_040;
    let began!: () => void;
    const started = new Promise<void>((resolve) => (began = resolve));
    let resolveBody!: (body: unknown) => void;
    const lateBody = new Promise((resolve) => (resolveBody = resolve));
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn(async (_url, init) => {
      signal = init?.signal;
      if (fetcher.mock.calls.length === 1) {
        began();
        throw new TypeError('connection refused');
      }
      return { ok: true, json: () => lateBody };
    });
    vi.stubGlobal('fetch', fetcher);
    const waiting = phaseVerify(ctx);
    await started;
    await vi.advanceTimersByTimeAsync(2_039);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await waiting).toBe(false);
    expect(signal?.aborted).toBe(true);
    resolveBody({ version: '1.1.0', migrationHead: '0250' });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(ctx.log).mock.calls.map(([event]) => event)).not.toContain('verified');
    expect(vi.getTimerCount()).toBe(0);
  });
});
