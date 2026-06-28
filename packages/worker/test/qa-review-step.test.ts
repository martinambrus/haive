import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildReviewForm,
  collectReview,
  knowledgeQaReviewStep,
  parseQaReviewOutput,
  type QaReviewDetect,
} from '../src/step-engine/steps/onboarding/09_3-qa-review.js';

function detect(overrides: Partial<QaReviewDetect> = {}): QaReviewDetect {
  return {
    reviewable: [
      {
        key: '0',
        question: 'How does delivery work?',
        answer: 'Partial completes the item.',
        source: 'code',
        citedFile: 'src/order.ts',
        proposedWrite: { relPath: 'BUSINESS_LOGIC.md', section: 'Delivery', content: 'code body' },
      },
      {
        key: '1',
        question: 'Where is auth configured?',
        answer: 'See the KB.',
        source: 'kb',
        citedFile: '.claude/knowledge_base/AUTH.md',
      },
    ],
    unanswered: [{ key: '0', question: 'Why a nightly cron?', reason: 'no scheduler found' }],
    passthrough: [{ relPath: 'AGENT.md', section: 'Agent answer', content: 'user body' }],
    ...overrides,
  };
}

function fence(json: object): string {
  return '```json\n' + JSON.stringify(json) + '\n```';
}

/* ------------------------------------------------------------------ */
/* buildReviewForm                                                     */
/* ------------------------------------------------------------------ */

describe('buildReviewForm', () => {
  it('renders a review accordion + an unanswered accordion and does not auto-submit', () => {
    const form = buildReviewForm(detect());
    expect(form.fields).toHaveLength(2);
    const review = form.fields[0]!;
    const unanswered = form.fields[1]!;
    expect(review.id).toBe('review-answers');
    expect(unanswered.id).toBe('unanswered-questions');
    if (review.type !== 'accordion' || unanswered.type !== 'accordion') {
      throw new Error('expected accordions');
    }
    expect(review.items).toHaveLength(2);
    expect(review.items[0]!.fields[0]!.id).toBe('review__0');
    expect(review.items[0]!.fields[0]!.type).toBe('radio-with-textarea');
    expect(unanswered.items[0]!.fields[0]!.id).toBe('unanswered__0');
    // Answers render expanded by default so the user sees every answer up front.
    expect(review.items[0]!.defaultOpen).toBe(true);
    expect(unanswered.items[0]!.defaultOpen).toBe(true);
    expect(form.autoSubmit).toBeUndefined();
  });

  it('auto-submits when nothing needs review (passthrough-only)', () => {
    const form = buildReviewForm(detect({ reviewable: [], unanswered: [] }));
    expect(form.fields).toHaveLength(0);
    expect(form.autoSubmit).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* collectReview                                                       */
/* ------------------------------------------------------------------ */

describe('collectReview', () => {
  it('treats untouched (empty) and the confirm sentinel as confirmed', () => {
    const r = collectReview(detect(), { review__0: '', review__1: '__confirm__' });
    expect(r.confirmedCount).toBe(2);
    expect(r.corrections).toHaveLength(0);
    // Only the code-sourced confirmed answer yields a deterministic write; the
    // kb-sourced one is already in the KB.
    expect(r.confirmedWrites).toHaveLength(1);
    expect(r.confirmedWrites[0]!.relPath).toBe('BUSINESS_LOGIC.md');
  });

  it('captures a correction and drops its proposed write', () => {
    const r = collectReview(detect(), { review__0: 'Actually it splits the order.' });
    expect(r.corrections).toHaveLength(1);
    expect(r.corrections[0]!.userAnswer).toBe('Actually it splits the order.');
    expect(r.corrections[0]!.source).toBe('code');
    // review__1 untouched -> confirmed (kb, no write). corrected answer is NOT in confirmedWrites.
    expect(r.confirmedCount).toBe(1);
    expect(r.confirmedWrites).toHaveLength(0);
  });

  it('captures a newly supplied answer for an unanswered question', () => {
    const r = collectReview(detect(), { unanswered__0: 'It rebuilds the search index.' });
    expect(r.newAnswers).toHaveLength(1);
    expect(r.newAnswers[0]!.question).toBe('Why a nightly cron?');
    expect(r.newAnswers[0]!.userAnswer).toBe('It rebuilds the search index.');
  });

  it('leaves an unanswered question unanswered on the skip sentinel', () => {
    const r = collectReview(detect(), { unanswered__0: '__skip__' });
    expect(r.newAnswers).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* parseQaReviewOutput (lenient)                                       */
/* ------------------------------------------------------------------ */

describe('parseQaReviewOutput', () => {
  it('parses a valid write summary', () => {
    const out = parseQaReviewOutput(
      fence({ kbWrites: [{ relPath: '.claude/knowledge_base/X.md', section: 'S' }] }),
    );
    expect(out.kbWrites).toHaveLength(1);
    expect(out.kbWrites[0]!.section).toBe('S');
  });

  it('degrades to an empty summary on unparseable output (never throws)', () => {
    expect(parseQaReviewOutput('no json here').kbWrites).toEqual([]);
    expect(parseQaReviewOutput(undefined).kbWrites).toEqual([]);
    expect(parseQaReviewOutput(fence({ kbWrites: 'nope' })).kbWrites).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* knowledgeQaReviewStep.apply                                         */
/* ------------------------------------------------------------------ */

describe('knowledgeQaReviewStep.apply', () => {
  let tmpRoot: string;
  let kbDir: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'qa-review-'));
    kbDir = path.join(tmpRoot, '.claude', 'knowledge_base');
    await mkdir(kbDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  function makeCtx(): Parameters<typeof knowledgeQaReviewStep.apply>[0] {
    return {
      taskId: 't',
      taskStepId: 's',
      userId: 'u',
      repoPath: tmpRoot,
      workspacePath: tmpRoot,
      sandboxWorkdir: '/repo',
      cliProviderId: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: undefined as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: { info() {}, warn() {}, error() {}, debug() {} } as any,
      async emitProgress() {},
    };
  }

  it('writes confirmed code proposals + passthrough deterministically (LLM skipped)', async () => {
    const out = await knowledgeQaReviewStep.apply(makeCtx(), {
      detected: detect(),
      formValues: {}, // everything confirmed, no corrections
      llmOutput: undefined, // LLM was skipped
    });
    const biz = await readFile(path.join(kbDir, 'BUSINESS_LOGIC.md'), 'utf8');
    const agent = await readFile(path.join(kbDir, 'AGENT.md'), 'utf8');
    expect(biz).toContain('## Delivery');
    expect(agent).toContain('## Agent answer');
    expect(out.kbWritten).toHaveLength(2);
    expect(out.confirmedCount).toBe(2);
    expect(out.correctedCount).toBe(0);
    expect(out.stillUnansweredCount).toBe(1);
  });

  it('records the agent write summary for corrected answers', async () => {
    const out = await knowledgeQaReviewStep.apply(makeCtx(), {
      detected: detect(),
      formValues: { review__0: 'Corrected.', unanswered__0: 'A new answer.' },
      llmOutput: fence({
        kbWrites: [{ relPath: '.claude/knowledge_base/BUSINESS_LOGIC.md', section: 'Delivery' }],
      }),
    });
    // Deterministic: passthrough only (the corrected code answer is no longer confirmed).
    // LLM summary: the corrected section.
    expect(out.correctedCount).toBe(1);
    expect(out.newlyAnsweredCount).toBe(1);
    expect(out.stillUnansweredCount).toBe(0);
    expect(out.kbWritten.map((w) => w.relPath)).toContain(
      '.claude/knowledge_base/BUSINESS_LOGIC.md',
    );
  });
});
