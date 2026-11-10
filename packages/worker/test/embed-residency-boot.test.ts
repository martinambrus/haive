import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@haive/shared';
import { listResidentOllamaModels } from '@haive/shared/rag';
import { listResidentModelsOnBoot } from '../src/queues/embed-residency-boot.js';

vi.mock('@haive/shared/rag', () => ({ listResidentOllamaModels: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

describe('boot residency refusal diagnostics', () => {
  it('warns once per URL per boot with only the host and preserves null', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.mocked(listResidentOllamaModels).mockImplementation(
      async (_url, _timeout, _fetch, refused) => {
        refused?.();
        return null;
      },
    );
    const first =
      'http://secret-user:secret-password@private.lan:11434/secret-path?token=secret-token';
    expect(await listResidentModelsOnBoot(first)).toBeNull();
    expect(await listResidentModelsOnBoot(first)).toBeNull();
    expect(await listResidentModelsOnBoot('http://private.lan:11435')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    for (const [fields, message] of warn.mock.calls) {
      expect(fields).toEqual({ host: 'private.lan' });
      expect(message).toContain('residency');
    }
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
  });

  it('keeps successful and ordinary unreachable results without a refusal warning', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.mocked(listResidentOllamaModels)
      .mockResolvedValueOnce(['embed:latest'])
      .mockResolvedValueOnce(null);
    expect(await listResidentModelsOnBoot('http://success.lan')).toEqual(['embed:latest']);
    expect(await listResidentModelsOnBoot('http://down.lan')).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});
