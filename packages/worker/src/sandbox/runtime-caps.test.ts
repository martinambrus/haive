import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigUnavailableError, configService } from '@haive/shared';
import { resolveRunnerCaps, resourceLimitsEnabled } from './runtime-caps.js';

describe('runtime caps with an unreadable config store', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fails the spawn path but keeps resourceLimitsEnabled() lenient', async () => {
    vi.spyOn(configService, 'getBoolean').mockRejectedValue(new ConfigUnavailableError('get'));
    await expect(resolveRunnerCaps('t')).rejects.toBeInstanceOf(ConfigUnavailableError);
    await expect(resourceLimitsEnabled()).resolves.toBe(false);
  });

  it('resolves null on any other enable-read failure', async () => {
    vi.spyOn(configService, 'getBoolean').mockRejectedValue(
      new Error('ConfigService not initialized'),
    );
    await expect(resolveRunnerCaps('t')).resolves.toBeNull();
  });

  it('rejects when the flag is on and a cap read is unreadable', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
    vi.spyOn(configService, 'getNumber').mockRejectedValue(new ConfigUnavailableError('get'));
    await expect(resolveRunnerCaps('t')).rejects.toBeInstanceOf(ConfigUnavailableError);
  });

  it('returns null without reading a cap when the flag is off', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    const getNumber = vi.spyOn(configService, 'getNumber');
    await expect(resolveRunnerCaps('t')).resolves.toBeNull();
    expect(getNumber).not.toHaveBeenCalled();
  });
});
