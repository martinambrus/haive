import { describe, expect, it } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  ledgerImportedSince,
  loadNewestLiveArtifactAt,
  loadNewestLiveImportAt,
} from '../src/onboarding-admission.js';
import { PROJECT_STATE_IMPORT_STEP_ID } from '../src/project-state/index.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000c1';

const at = (day: number) => new Date(Date.UTC(2026, 9, day));

function setup() {
  const fake = createFakeDb({ onboardingArtifacts: schema.onboardingArtifacts });
  let n = 0;
  const row = (over: Record<string, unknown>) =>
    fake.insert(schema.onboardingArtifacts, {
      userId: USER,
      repositoryId: REPO,
      taskId: TASK,
      diskPath: `.claude/f${(n += 1)}.md`,
      templateId: 't',
      templateKind: 'agent',
      templateSchemaVersion: 1,
      templateContentHash: 'h',
      writtenHash: 'h',
      sourceStepId: '12-post-onboarding',
      source: 'onboarding',
      generatedAt: at(1),
      ...over,
    });
  const marker = (over: Record<string, unknown> = {}) =>
    row({
      taskId: null,
      source: 'backfill',
      sourceStepId: PROJECT_STATE_IMPORT_STEP_ID,
      importedAt: at(5),
      generatedAt: at(5),
      ...over,
    });
  const db = fake.db as unknown as Database;
  return { row, marker, db };
}

describe('loadNewestLiveArtifactAt with import markers', () => {
  it('dates a live marker by imported_at', async () => {
    const t = setup();
    t.row({ generatedAt: at(2) });
    t.marker({ importedAt: at(7), generatedAt: at(3) });
    expect((await loadNewestLiveArtifactAt(t.db, USER, [REPO])).get(REPO)).toEqual(at(7));
  });

  it('counts a marker alone', async () => {
    const t = setup();
    t.marker({ importedAt: at(4) });
    expect((await loadNewestLiveArtifactAt(t.db, USER, [REPO])).get(REPO)).toEqual(at(4));
  });

  it('ignores a superseded marker and upgrade, rollback and plain backfill rows', async () => {
    const t = setup();
    t.marker({ supersededAt: at(9) });
    t.row({ source: 'upgrade', generatedAt: at(8) });
    t.row({ source: 'rollback', generatedAt: at(8) });
    t.row({ source: 'backfill', sourceStepId: '01-upgrade-plan', generatedAt: at(8) });
    expect((await loadNewestLiveArtifactAt(t.db, USER, [REPO])).has(REPO)).toBe(false);
  });
});

describe('loadNewestLiveImportAt', () => {
  it('reads only live markers, never an onboarding row', async () => {
    const t = setup();
    t.row({ generatedAt: at(20) });
    t.marker({ importedAt: at(4) });
    t.marker({ importedAt: at(6), supersededAt: at(7) });
    expect((await loadNewestLiveImportAt(t.db, USER, [REPO])).get(REPO)).toEqual(at(4));
  });

  it('has nothing for a repository with no marker', async () => {
    const t = setup();
    t.row({});
    expect((await loadNewestLiveImportAt(t.db, USER, [REPO])).has(REPO)).toBe(false);
  });
});

describe('ledgerImportedSince', () => {
  it('is true for an import after the date, live or superseded', async () => {
    const t = setup();
    t.marker({ importedAt: at(6), supersededAt: at(8) });
    expect(await ledgerImportedSince(t.db, REPO, at(5))).toBe(true);
  });

  it('is true for a local row an import retired after the date', async () => {
    const t = setup();
    t.row({ supersededAt: at(7), importedAt: at(7) });
    expect(await ledgerImportedSince(t.db, REPO, at(5))).toBe(true);
  });

  it('is false for an import at or before the date and for a ledger with none', async () => {
    const t = setup();
    t.row({});
    expect(await ledgerImportedSince(t.db, REPO, at(5))).toBe(false);
    t.marker({ importedAt: at(5) });
    expect(await ledgerImportedSince(t.db, REPO, at(5))).toBe(false);
  });

  it('looks only at the repository', async () => {
    const t = setup();
    t.marker({ repositoryId: '00000000-0000-4000-8000-0000000000b2', importedAt: at(9) });
    expect(await ledgerImportedSince(t.db, REPO, at(5))).toBe(false);
  });
});
