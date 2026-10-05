import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ideSessionKey, repoIdeSessionId } from '@haive/shared';

const h = vi.hoisted(() => ({
  enabled: true,
  db: {},
  runner: vi.fn(),
  settings: vi.fn(),
  hset: vi.fn(),
}));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: { getBoolean: async () => h.enabled },
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/redis.js', () => ({ getRedis: () => ({ hset: h.hset }), getBullRedis: vi.fn() }));
vi.mock('../src/sandbox/ide-runner.js', () => ({
  ensureRepoIdeRunnerStarted: h.runner,
  ensureIdeRunnerStarted: vi.fn(),
}));
vi.mock('../src/sandbox/ide-settings.js', () => ({ resolveIdeSettingsJson: h.settings }));
import { ensureIdeForRepo } from '../src/queues/ide-ensure-queue.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';

beforeEach(() => {
  h.enabled = true;
  h.runner.mockReset().mockResolvedValue({ container: 'editor' });
  h.settings.mockReset().mockResolvedValue('{"editor.fontSize":16}');
  h.hset.mockReset().mockResolvedValue(1);
});

describe('repository editor ensure job', () => {
  it('uses the user’s settings and registers idle cleanup before any browser connects', async () => {
    const before = Date.now();
    expect(await ensureIdeForRepo(REPO, USER)).toEqual({ ok: true });
    expect(h.settings).toHaveBeenCalledWith(h.db, USER);
    expect(h.runner).toHaveBeenCalledWith(h.db, REPO, USER, '{"editor.fontSize":16}');
    expect(h.hset).toHaveBeenCalledWith(
      ideSessionKey(repoIdeSessionId(REPO)),
      'lastSeenAt',
      expect.any(String),
    );
    expect(Number(h.hset.mock.calls[0]![2])).toBeGreaterThanOrEqual(before);
  });

  it('does not launch or register a disabled editor', async () => {
    h.enabled = false;
    expect(await ensureIdeForRepo(REPO, USER)).toEqual({ ok: false, reason: 'disabled' });
    expect(h.runner).not.toHaveBeenCalled();
    expect(h.hset).not.toHaveBeenCalled();
  });

  it('does not register an editor with no editable workspace', async () => {
    h.runner.mockResolvedValue(null);
    expect(await ensureIdeForRepo(REPO, USER)).toEqual({ ok: false, reason: 'no-editable-repo' });
    expect(h.hset).not.toHaveBeenCalled();
  });
});
