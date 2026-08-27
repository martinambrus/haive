import { describe, expect, it } from 'vitest';
import { planChatStep } from './01-plan-chat.js';

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
    expect(evaluate({ continueRequested: true } as never, {} as never)).toEqual({
      targetStepId: '01-plan-chat',
    });
  });

  it('ends when the user submits nothing', () => {
    expect(evaluate({ continueRequested: false } as never, {} as never)).toBeNull();
  });
});
