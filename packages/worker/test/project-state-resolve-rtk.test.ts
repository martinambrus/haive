import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  RTK_ENABLED_UNIT,
  conflictSide,
  type ProjectStateAnswer,
} from '@haive/shared/project-state';
import { resolveProjectStateConflict } from '../src/project-state/resolve.js';

const OWNER = '00000000-0000-4000-8000-0000000000a1';
const STRANGER = '00000000-0000-4000-8000-0000000000a2';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const UPDATED = new Date(1000);

function setup(over: { rtkEnabled?: boolean; incoming?: unknown } = {}) {
  const fake = createFakeDb({
    repositories: schema.repositories,
    projectStateSync: schema.projectStateSync,
    projectStateConflicts: schema.projectStateConflicts,
    projectStateOutbox: schema.projectStateOutbox,
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    onboardingArtifacts: schema.onboardingArtifacts,
  });
  fake.insert(schema.repositories, {
    id: REPO,
    userId: OWNER,
    name: 'acme',
    source: 'git_https',
    status: 'ready',
    storagePath: null,
    rtkEnabled: over.rtkEnabled ?? true,
    renderContext: null,
    updatedAt: UPDATED,
  });
  const id = randomUUID();
  fake.insert(schema.projectStateConflicts, {
    id,
    repositoryId: REPO,
    unit: RTK_ENABLED_UNIT,
    base: conflictSide(true),
    local: conflictSide(true),
    incoming: 'incoming' in over ? conflictSide(over.incoming) : conflictSide(false),
    detectedAt: new Date(2000),
    resolution: null,
    resolvedAt: null,
    resolvedBy: null,
  });
  const db = fake.db as unknown as Database;
  const answer = (a: ProjectStateAnswer, userId = OWNER) =>
    resolveProjectStateConflict(db, { repositoryId: REPO, userId, conflictId: id, answer: a });
  const repo = () => fake.rows(schema.repositories)[0]!;
  const row = () => fake.rows(schema.projectStateConflicts)[0]!;
  const outbox = () => fake.rows(schema.projectStateOutbox);
  return { fake, id, answer, repo, row, outbox };
}

describe('answering the RTK question: take theirs', () => {
  it('switches RTK off the way the tooling page does, stamps the row and writes no file', async () => {
    const s = setup();

    const result = await s.answer('take_theirs');

    expect(result).toMatchObject({
      kind: 'resolved',
      written: [],
      conflict: {
        id: s.id,
        unit: RTK_ENABLED_UNIT,
        resolution: 'take_theirs',
        incoming: { present: true, value: false },
      },
    });
    expect(s.repo().rtkEnabled).toBe(false);
    expect((s.repo().updatedAt as Date).getTime()).toBeGreaterThan(UPDATED.getTime());
    expect(s.row()).toMatchObject({ resolution: 'take_theirs', resolvedBy: OWNER });
    expect(s.row().resolvedAt).toBeInstanceOf(Date);
    expect(s.fake.rows(schema.projectStateSync)).toEqual([]);
  });

  it('records the answer as a switch a person made on this install', async () => {
    const s = setup();

    await s.answer('take_theirs');

    expect(s.repo().rtkChoiceMadeAt).toBeInstanceOf(Date);
  });

  it('answered again the same way returns the closed row and changes nothing', async () => {
    const s = setup();
    const first = await s.answer('take_theirs');
    const before = JSON.stringify([s.repo(), s.row()]);

    const again = await s.answer('take_theirs');

    expect(again).toEqual(first);
    expect(JSON.stringify([s.repo(), s.row()])).toBe(before);
  });

  it('answered the other way afterwards is settled and leaves RTK off', async () => {
    const s = setup();
    await s.answer('take_theirs');

    expect(await s.answer('keep_mine')).toEqual({ kind: 'settled', resolution: 'take_theirs' });
    expect(s.repo().rtkEnabled).toBe(false);
  });

  it('is invalid, and changes nothing, when the incoming side is no boolean', async () => {
    const s = setup({ incoming: 'off' });

    expect(await s.answer('take_theirs')).toEqual({ kind: 'invalid' });
    expect(s.repo().rtkEnabled).toBe(true);
    expect(s.repo().rtkChoiceMadeAt).toBeNull();
    expect(s.row().resolvedAt).toBeNull();
  });
});

describe('answering the RTK question: keep mine', () => {
  it('leaves RTK on, records the choice, stamps the row and writes nothing else', async () => {
    const s = setup();

    const result = await s.answer('keep_mine');

    expect(result).toMatchObject({
      kind: 'resolved',
      written: [],
      conflict: { id: s.id, resolution: 'keep_mine' },
    });
    expect(s.repo().rtkEnabled).toBe(true);
    expect(s.repo().rtkChoiceMadeAt).toBeInstanceOf(Date);
    expect((s.repo().updatedAt as Date).getTime()).toBe(UPDATED.getTime());
    expect(s.row()).toMatchObject({ resolution: 'keep_mine', resolvedBy: OWNER });
  });

  it('answered again the same way returns the same body, the other way is settled', async () => {
    const s = setup();
    const first = await s.answer('keep_mine');

    const before = JSON.stringify([s.repo(), s.row()]);

    expect(await s.answer('keep_mine')).toEqual(first);
    expect(JSON.stringify([s.repo(), s.row()])).toBe(before);
    expect(await s.answer('take_theirs')).toEqual({ kind: 'settled', resolution: 'keep_mine' });
    expect(s.repo().rtkEnabled).toBe(true);
  });
});

describe('answering the RTK question: the record', () => {
  it.each(['take_theirs', 'keep_mine'] as const)(
    'marks the project state record dirty on %s, once',
    async (answer) => {
      const s = setup();

      await s.answer(answer);
      await s.answer(answer);

      expect(s.outbox()).toEqual([
        expect.objectContaining({ repositoryId: REPO, revision: 1, writtenRevision: 0 }),
      ]);
    },
  );

  it('marks nothing for an answer that is refused', async () => {
    const s = setup({ incoming: 'off' });

    await s.answer('take_theirs');

    expect(s.outbox()).toEqual([]);
  });
});

describe('answering the RTK question: who and when', () => {
  it('is not found for another user, and changes nothing', async () => {
    const s = setup();

    expect(await s.answer('take_theirs', STRANGER)).toEqual({ kind: 'not_found' });
    expect(s.repo().rtkEnabled).toBe(true);
    expect(s.repo().rtkChoiceMadeAt).toBeNull();
    expect(s.row().resolvedAt).toBeNull();
  });

  it('is busy while an onboarding or an upgrade holds the checkout, and changes nothing', async () => {
    const s = setup();
    s.fake.insert(schema.tasks, {
      id: randomUUID(),
      userId: OWNER,
      repositoryId: REPO,
      type: 'onboarding_upgrade',
      status: 'running',
      title: 't',
    });

    expect(await s.answer('take_theirs')).toEqual({ kind: 'busy' });
    expect(s.repo().rtkEnabled).toBe(true);
    expect(s.repo().rtkChoiceMadeAt).toBeNull();
    expect(s.row().resolvedAt).toBeNull();
  });
});
