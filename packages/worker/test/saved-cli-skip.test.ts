import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Database } from '@haive/database';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';
import { noteSavedCliSkip, savedCliSkipNote } from '../src/step-engine/saved-cli-skip.js';
import { StepSupersededError, appendStepWarning } from '../src/step-engine/step-ownership.js';

const ran = { id: randomUUID(), name: 'claude-code', label: 'Claude Code' } as CliProviderRecord;

function capturingDb() {
  const sets: Record<string, unknown>[] = [];
  const db = {
    update: () => ({
      set: (v: Record<string, unknown>) => {
        sets.push(v);
        return { where: () => ({ returning: async () => [{ id: 'row' }] }) };
      },
    }),
  } as unknown as Database;
  return { db, sets };
}

describe('savedCliSkipNote', () => {
  it('names the skipped CLI and the one that ran', () => {
    const note = savedCliSkipNote({
      provider: ran,
      skippedSavedPreference: { providerId: randomUUID(), label: 'Codex' },
    });
    expect(note).toContain('("Codex")');
    expect(note).toContain('ran on "Claude Code"');
    expect(note).toContain('its language-server setup only allows another CLI');
  });

  it('drops the parenthesis when the skipped CLI has no label', () => {
    const note = savedCliSkipNote({
      provider: ran,
      skippedSavedPreference: { providerId: randomUUID(), label: null },
    });
    expect(note).not.toContain('("');
    expect(note).toContain('saved CLI for this step cannot launch');
  });

  it('is null without a skipped pick or without a provider', () => {
    expect(savedCliSkipNote({ provider: ran })).toBeNull();
    expect(
      savedCliSkipNote({
        provider: null,
        skippedSavedPreference: { providerId: randomUUID(), label: 'Codex' },
      }),
    ).toBeNull();
  });
});

describe('appendStepWarning', () => {
  it('appends in one statement with the note as a typed parameter', async () => {
    const { db, sets } = capturingDb();
    await appendStepWarning(db, randomUUID(), 'a note');
    const { sql, params } = new PgDialect().sqlToQuery(sets[0]!.warningMessage as SQL);
    expect(sql).toContain('strpos(coalesce("task_steps"."warning_message", \'\'), $1::text)');
    expect(sql).toContain(
      'concat_ws(\' \', nullif("task_steps"."warning_message", \'\'), $2::text)',
    );
    expect(params).toEqual(['a note', 'a note']);
  });
});

describe('noteSavedCliSkip', () => {
  it('writes only when a saved pick was skipped', async () => {
    const { db, sets } = capturingDb();
    await noteSavedCliSkip(db, randomUUID(), { provider: ran } as never);
    expect(sets).toHaveLength(0);
    await noteSavedCliSkip(db, randomUUID(), {
      provider: ran,
      skippedSavedPreference: { providerId: randomUUID(), label: 'Codex' },
    } as never);
    expect(sets).toHaveLength(1);
  });

  const skipped = {
    provider: ran,
    skippedSavedPreference: { providerId: randomUUID(), label: 'Codex' },
  } as never;

  it('resolves when the UPDATE throws a plain error', async () => {
    const db = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => {
              throw new Error('connection lost');
            },
          }),
        }),
      }),
    } as unknown as Database;
    await expect(noteSavedCliSkip(db, randomUUID(), skipped)).resolves.toBeUndefined();
  });

  it('rethrows StepSupersededError when the step row is no longer owned', async () => {
    const db = {
      update: () => ({
        set: () => ({ where: () => ({ returning: async () => [] }) }),
      }),
    } as unknown as Database;
    await expect(noteSavedCliSkip(db, randomUUID(), skipped)).rejects.toBeInstanceOf(
      StepSupersededError,
    );
  });
});
