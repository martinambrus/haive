import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { configService, ConfigUnavailableError } from '@haive/shared';
import type { AppEnv } from '../src/context.js';
import { mountModules } from '../src/modules/loader.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('api boot against an unavailable configuration store', () => {
  it('retries bootstrap through retryWhileConfigUnavailable', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/await retryWhileConfigUnavailable\('api bootstrap', bootstrap\)/);
    expect(source).not.toMatch(/await bootstrap\(\)/);
  });

  const entry = (routes: () => Hono<AppEnv>) => ({
    packageName: '@haive/module-fx',
    manifest: {
      id: 'fx',
      name: 'Module fx',
      version: '1.0.0',
      schemaVersion: 1,
      globalSettings: {
        form: { title: 'Fx', fields: [{ id: 'flag', type: 'text', label: 'Flag' }] },
        defaults: { flag: 'on' },
      },
    },
    routes,
  });
  const ctx = { db: {} as Database };

  it('retries the settings defaults write without mounting the routes twice', async () => {
    vi.useFakeTimers();
    const setIfAbsent = vi
      .spyOn(configService, 'setIfAbsent')
      .mockRejectedValueOnce(new ConfigUnavailableError('setIfAbsent'))
      .mockRejectedValueOnce(new ConfigUnavailableError('setIfAbsent'))
      .mockResolvedValue(true);
    const routes = vi.fn(() => new Hono<AppEnv>());

    const done = mountModules(new Hono<AppEnv>(), [entry(routes) as never], ctx);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(done).resolves.toHaveLength(1);

    expect(routes).toHaveBeenCalledTimes(1);
    expect(setIfAbsent).toHaveBeenCalledTimes(3);
    expect(setIfAbsent.mock.calls.every(([key]) => key.includes('flag'))).toBe(true);
  });

  it('still rejects at once on any other error', async () => {
    const setIfAbsent = vi.spyOn(configService, 'setIfAbsent').mockRejectedValue(new Error('boom'));
    await expect(
      mountModules(new Hono<AppEnv>(), [entry(() => new Hono<AppEnv>()) as never], ctx),
    ).rejects.toThrow('boom');
    expect(setIfAbsent).toHaveBeenCalledTimes(1);
  });
});
