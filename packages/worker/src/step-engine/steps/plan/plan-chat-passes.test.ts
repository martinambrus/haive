import { describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { planChatStep } from './01-plan-chat.js';
import { applyAgentPatch } from './_plan-prompt.js';

vi.mock('./_plan-prompt.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./_plan-prompt.js')>();
  return { ...actual, applyAgentPatch: vi.fn() };
});
vi.mock('../../../plan/mirror.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../plan/mirror.js')>();
  return { ...actual, writePlanMirror: vi.fn(async () => {}) };
});

/**
 * The two-pass turn model.
 *
 * The engine runs detect, then form, then llm. A chat step that offered its
 * form on every pass therefore PARKED BEFORE ANSWERING: the user's message sat
 * unread while the form asked for the next one, and every reply arrived a turn
 * late. Measured on a live conversation before this shape existed.
 *
 * So a pass is one of two things, decided by `pendingQuestion`:
 *   answer  — a user turn is outstanding: run the llm, offer no form.
 *   collect — nothing outstanding: offer the form, spend no invocation.
 *
 * The two conditions are COMPLEMENTS, which is the invariant worth pinning:
 * change one without the other and the step either parks before replying (the
 * original bug) or burns a CLI invocation with nothing to answer.
 */
type Detected = Parameters<NonNullable<typeof planChatStep.form>>[1];

function detected(over: Partial<Detected> = {}): Detected {
  return {
    repositoryId: 'r1',
    nodeId: 'n1',
    nodeTitle: 'Mailer',
    nodeVersion: 3,
    planMarkdown: '# Plan',
    transcript: [],
    pendingQuestion: null,
    ...over,
  } as Detected;
}

const formOf = (d: Detected) => planChatStep.form!({} as never, d);
const skips = (d: Detected) =>
  planChatStep.llm!.skipIf!({ detected: d, formValues: {} } as never) === true;

describe('plan chat passes', () => {
  it('answers without parking when a user turn is outstanding', () => {
    const d = detected({ pendingQuestion: 'split this into two' });
    expect(formOf(d)).toBeNull();
    expect(skips(d)).toBe(false);
  });

  it('parks for the next message without spending an invocation', () => {
    const d = detected({ pendingQuestion: null });
    expect(formOf(d)).not.toBeNull();
    expect(skips(d)).toBe(true);
  });

  it('offers a form exactly when it has nothing to answer', () => {
    for (const pendingQuestion of [null, '', 'anything at all']) {
      const d = detected({ pendingQuestion });
      const parks = formOf(d) !== null;
      // An empty string is still a turn the user submitted, so it is answered
      // rather than treated as "nothing pending" — only null means that.
      expect(parks).toBe(pendingQuestion === null);
      expect(skips(d)).toBe(parks);
    }
  });

  it('has nothing to chat about without a node', () => {
    // A plan_chat task whose metadata lost its node id must not park on a form
    // nobody can answer.
    expect(formOf(detected({ nodeId: null }))).toBeNull();
  });

  it('asks for the next message and says blank ends it', () => {
    const form = formOf(detected());
    expect(form?.fields).toHaveLength(1);
    expect(form?.fields[0]?.id).toBe('message');
    // Not required: submitting nothing is how a person ends the conversation,
    // and a required field would make ending it impossible.
    expect(form?.fields[0]?.required).toBe(false);
    expect(form?.description).toMatch(/blank to end/i);
  });

  it('names the node it is a conversation about', () => {
    expect(formOf(detected({ nodeTitle: 'Mailer' }))?.title).toContain('Mailer');
  });
});

describe('plan chat revise loop', () => {
  const evaluate = planChatStep.reviseLoop!.evaluate;

  it('goes round again on the same card, never a new step per turn', () => {
    expect(evaluate({ continueRequested: true } as never)).toEqual({
      targetStepId: '01-plan-chat',
    });
  });

  it('ends when the user submits nothing', () => {
    expect(evaluate({ continueRequested: false } as never)).toBeNull();
  });
});

describe('plan chat reply', () => {
  function fakeDb(): { db: Database; turns: Record<string, unknown>[] } {
    const turns: Record<string, unknown>[] = [];
    const db = {
      insert: () => ({
        values: async (row: Record<string, unknown>) => {
          turns.push(row);
        },
      }),
    } as unknown as Database;
    return { db, turns };
  }

  const answer = (db: Database) =>
    planChatStep.apply(
      {
        taskId: 't',
        cliProviderId: null,
        repoPath: '/tmp',
        db,
        logger: { warn: () => {} },
      } as never,
      {
        detected: detected({ pendingQuestion: 'Add a retry queue' }),
        formValues: {},
        llmOutput: {
          ops: [
            { op: 'upsert', nodeRef: 'q', parentRef: 'n1', title: 'Retry queue' },
            { op: 'link', fromRef: 'q', toRef: 'gone', kind: 'depends_on' },
          ],
          reply: 'Added it.',
        },
      } as never,
    );

  const outcome = (dropped: string[], strippedCodeLinks: string[] = []) => ({
    created: ['c'],
    updated: [],
    deleted: [],
    linked: 0,
    unlinked: 0,
    codeLinked: 0,
    refs: { q: 'c' },
    dropped,
    strippedCodeLinks,
  });

  it('names the changes the applier skipped, so the reply does not claim them', async () => {
    const gone = "link dropped: unknown node reference 'gone'";
    vi.mocked(applyAgentPatch).mockResolvedValueOnce(outcome([gone]));
    const { db, turns } = fakeDb();
    await answer(db);
    expect(turns[0]?.body).toBe(`Added it.\n\n_1 change(s) not applied: ${gone}_`);
    // The header reads this: 1 of the 2 ops sent landed.
    expect(turns[0]?.patchJson).toMatchObject({ outcome: { applied: 1 } });
  });

  it('names a code link it could not record without counting a change as lost', async () => {
    const gone = "link dropped: unknown node reference 'gone'";
    const bad =
      "code link dropped from 'q': symbol: Too big: expected string to have <=512 characters";
    vi.mocked(applyAgentPatch).mockResolvedValueOnce(outcome([gone], [bad]));
    const { db, turns } = fakeDb();
    await answer(db);
    expect(turns[0]?.body).toBe(
      `Added it.\n\n_1 change(s) not applied: ${gone}_\n\n_1 code link(s) not recorded: ${bad}_`,
    );
    // The link cost no op: 1 of the 2 sent still landed, exactly as without it.
    expect(turns[0]?.patchJson).toMatchObject({ outcome: { applied: 1 } });
  });

  it('leaves a reply whose patch landed whole as the agent wrote it', async () => {
    vi.mocked(applyAgentPatch).mockResolvedValueOnce(outcome([]));
    const { db, turns } = fakeDb();
    await answer(db);
    expect(turns[0]?.body).toBe('Added it.');
    expect(turns[0]?.patchJson).toMatchObject({ outcome: { applied: 2 } });
  });

  it('records a patch the applier refused as having landed nothing', async () => {
    // The whole patch rolled back, so a header counting the ops SENT claimed two
    // changes on a turn that made none.
    vi.mocked(applyAgentPatch).mockRejectedValueOnce(
      new Error('plan node n1 was modified by someone else'),
    );
    const { db, turns } = fakeDb();
    await answer(db);
    expect(turns[0]?.body).toBe('Added it.\n\n_plan node n1 was modified by someone else_');
    expect(turns[0]?.patchJson).toMatchObject({ outcome: { applied: 0 } });
  });
});

describe('plan chat history', () => {
  it('sends the newest turns that fit, not the whole conversation', () => {
    const transcript = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      body: `turn-${i}-${'z'.repeat(2_000)}`,
    }));
    const prompt = planChatStep.llm!.buildPrompt({
      detected: detected({ transcript, pendingQuestion: 'latest' } as Partial<Detected>),
      formValues: {},
      iteration: 0,
    } as never) as string;
    expect(prompt).toContain('turn-38-');
    expect(prompt).not.toContain('turn-0-');
    expect(prompt).toMatch(/\(\d+ earlier turns of this conversation are not shown\)/);
  });
});

describe('plan chat provider attribution', () => {
  const taskId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const nodeId = 'aaaaaaaa-0000-4000-8000-000000000002';
  const invocationId = 'aaaaaaaa-0000-4000-8000-000000000003';
  const ran = 'bbbbbbbb-0000-4000-8000-000000000001';
  const other = 'cccccccc-0000-4000-8000-000000000001';

  async function reply(taskProvider: string | null, runId: string | null, output: unknown) {
    const fake = createFakeDb({
      cliInvocations: schema.cliInvocations,
      planNodeMessages: schema.planNodeMessages,
    });
    fake.insert(schema.cliInvocations, { id: invocationId, cliProviderId: ran });
    // A newer run must not replace the one whose reply apply received.
    fake.insert(schema.cliInvocations, {
      id: 'aaaaaaaa-0000-4000-8000-000000000004',
      cliProviderId: other,
    });
    const db = fake.db as unknown as Database;
    await planChatStep.apply(
      {
        taskId,
        cliProviderId: taskProvider,
        repoPath: '/repo',
        db,
        logger: { warn() {} },
      } as never,
      {
        detected: detected({ nodeId, pendingQuestion: 'What belongs here?' }),
        formValues: {},
        llmOutput: output,
        llmInvocationId: runId,
        iteration: 0,
        previousIterations: [],
      },
    );
    return db.select().from(schema.planNodeMessages);
  }

  it('records the run provider when the step context names none', async () => {
    const turns = await reply(null, invocationId, { ops: [], reply: 'The mail queue.' });
    expect(turns).toHaveLength(1);
    expect(turns[0]?.cliProviderId).toBe(ran);
  });

  it('records the run provider when a per-step choice overrides the task CLI', async () => {
    const turns = await reply(other, invocationId, { ops: [], reply: 'The mail queue.' });
    expect(turns[0]?.cliProviderId).toBe(ran);
  });

  it('records no provider when no run produced the reply', async () => {
    const turns = await reply(other, null, null);
    expect(turns[0]?.cliProviderId).toBeNull();
  });

  it('does not guess when the supplied invocation no longer exists', async () => {
    const turns = await reply(other, 'aaaaaaaa-0000-4000-8000-000000000005', 'A prose reply.');
    expect(turns[0]?.cliProviderId).toBeNull();
  });
});
