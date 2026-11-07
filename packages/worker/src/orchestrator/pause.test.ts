import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { ConfigUnavailableError, configService } from '@haive/shared';
import { pauseParkMessage, resolvePause } from './pause.js';

/** A db whose task-row read answers `row`, or throws when `row` is an Error. */
function fakeDb(row: { pausedAt: Date | null } | Error): Database {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if (row instanceof Error) throw row;
            return [row];
          },
        }),
      }),
    }),
  } as unknown as Database;
}

afterEach(() => vi.restoreAllMocks());

describe('resolvePause', () => {
  it('answers global when the switch is on', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
    expect(await resolvePause(fakeDb({ pausedAt: null }), 't')).toBe('global');
  });

  it('answers task for a paused row and null for a live one', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    expect(await resolvePause(fakeDb({ pausedAt: new Date() }), 't')).toBe('task');
    expect(await resolvePause(fakeDb({ pausedAt: null }), 't')).toBeNull();
  });

  it('holds as unreadable when the config store is unavailable', async () => {
    vi.spyOn(configService, 'getBoolean').mockRejectedValue(
      new ConfigUnavailableError('getBoolean'),
    );
    expect(await resolvePause(fakeDb({ pausedAt: null }), 't')).toBe('unreadable');
  });

  it('keeps going to the task row on any other global read error', async () => {
    vi.spyOn(configService, 'getBoolean').mockRejectedValue(new Error('not initialized'));
    expect(await resolvePause(fakeDb({ pausedAt: null }), 't')).toBeNull();
    expect(await resolvePause(fakeDb({ pausedAt: new Date() }), 't')).toBe('task');
  });

  it('holds as unreadable when the task row cannot be read', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    expect(await resolvePause(fakeDb(new Error('db down')), 't')).toBe('unreadable');
  });
});

describe('pauseParkMessage', () => {
  it.each(['task', 'global'] as const)(
    'never tells the reader to resume in the %s scope, since the plan chat and plan merge print it to a viewer who may be locked out',
    (scope) => {
      expect(pauseParkMessage(scope)).not.toMatch(/\bresume\b/i);
    },
  );

  it.each(['task', 'global'] as const)('still says the step is paused in the %s scope', (scope) => {
    expect(pauseParkMessage(scope)).toMatch(/^Paused/);
  });

  it('does not claim a pause or promise a resume when the pause state is unreadable', () => {
    const text = pauseParkMessage('unreadable');
    expect(text).not.toMatch(/^Paused/);
    expect(text).not.toMatch(/\bresume\b/i);
  });
});
