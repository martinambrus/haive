import { execFileSync } from 'node:child_process';
import {
  chown,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
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
import { snapshotKnowledgeBase } from '../src/step-engine/steps/onboarding/_kb-agent-files.js';

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
        citedFile: '.haive-data/knowledge_base/AUTH.md',
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
      fence({ kbWrites: [{ relPath: '.haive-data/knowledge_base/X.md', section: 'S' }] }),
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
    kbDir = path.join(tmpRoot, '.haive-data', 'knowledge_base');
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
      db: {
        update: () => ({
          set: () => ({ where: () => ({ returning: async () => [{ id: 's' }] }) }),
        }),
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: { info() {}, warn() {}, error() {}, debug() {} } as any,
      async emitProgress() {},
      round: 0,
      signal: new AbortController().signal,
      throwIfCancelled: () => {},
    };
  }

  it('writes confirmed code proposals + passthrough deterministically (LLM skipped)', async () => {
    await rm(kbDir, { recursive: true });
    const out = await knowledgeQaReviewStep.apply(makeCtx(), {
      iteration: 0,
      previousIterations: [],
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

  it('keeps an absent KB marker absent when unanswered questions are skipped', async () => {
    await rm(kbDir, { recursive: true });
    const out = await knowledgeQaReviewStep.apply(makeCtx(), {
      iteration: 0,
      previousIterations: [],
      detected: detect({ reviewable: [], passthrough: [] }),
      formValues: { unanswered__0: '__skip__' },
      llmOutput: undefined,
    });
    expect(out.kbWritten).toEqual([]);
    expect(out.stillUnansweredCount).toBe(1);
    await expect(stat(kbDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['captured', 'missing'] as const)(
    'fails an unapplied owner correction when the agent honestly reports no writes (T293, %s baseline)',
    async (baseline) => {
      await writeFile(path.join(kbDir, 'AUTH.md'), '# Auth\n\nOld answer.\n');
      const ctx = makeCtx();
      const detected = detect({ passthrough: [] });
      if (baseline === 'captured') {
        await knowledgeQaReviewStep.llm!.prepareWorkspace!({ ctx, detected, formValues: {} });
        expect(detected.kbBefore).toEqual(await snapshotKnowledgeBase(tmpRoot));
        expect(detected.kbBefore?.['.haive-data/knowledge_base/AUTH.md']).toBeDefined();
      }
      await expect(
        knowledgeQaReviewStep.apply(ctx, {
          iteration: 0,
          previousIterations: [],
          detected,
          formValues: { review__1: 'The owner supplied the corrected answer.' },
          // Captured normal corrector result after EACCES, not a claimed edit.
          llmOutput: fence({ kbWrites: [] }),
        }),
      ).rejects.toThrow(/not applied|unapplied/i);
      expect(await readFile(path.join(kbDir, 'AUTH.md'), 'utf8')).toContain('Old answer.');
    },
  );

  it('fails a claimed write whose KB bytes did not change', async () => {
    await writeFile(path.join(kbDir, 'AUTH.md'), '# Auth\n\nOld answer.\n');
    await expect(
      knowledgeQaReviewStep.apply(makeCtx(), {
        iteration: 0,
        previousIterations: [],
        detected: detect({ passthrough: [], kbBefore: await snapshotKnowledgeBase(tmpRoot) }),
        formValues: { review__1: 'Updated answer.' },
        llmOutput: fence({
          kbWrites: [{ relPath: '.haive-data/knowledge_base/AUTH.md', section: 'Auth' }],
        }),
      }),
    ).rejects.toThrow(/not applied|unapplied|baseline/i);
  });

  it('records verified direct edits for corrected and newly answered items', async () => {
    const detected = detect({ kbBefore: await snapshotKnowledgeBase(tmpRoot) });
    await writeFile(
      path.join(kbDir, 'BUSINESS_LOGIC.md'),
      '# Delivery\n\nCorrected plus new answer.\n',
    );
    const out = await knowledgeQaReviewStep.apply(makeCtx(), {
      iteration: 0,
      previousIterations: [],
      detected,
      formValues: { review__0: 'Corrected.', unanswered__0: 'A new answer.' },
      llmOutput: fence({
        kbWrites: [
          {
            relPath: '.haive-data/knowledge_base/BUSINESS_LOGIC.md',
            section: 'Delivery',
            question: 'Why a nightly cron?',
          },
        ],
      }),
    });
    // Deterministic: passthrough only (the corrected code answer is no longer confirmed).
    // LLM summary: the corrected section.
    expect(out.correctedCount).toBe(1);
    expect(out.newlyAnsweredCount).toBe(1);
    expect(out.stillUnansweredCount).toBe(0);
    expect(out.kbWritten.map((w) => w.relPath)).toContain(
      '.haive-data/knowledge_base/BUSINESS_LOGIC.md',
    );
  });
  it('keeps real direct edits when the summary is unparseable', async () => {
    const detected = detect({
      reviewable: [detect().reviewable[1]!],
      passthrough: [],
      kbBefore: await snapshotKnowledgeBase(tmpRoot),
    });
    await writeFile(path.join(kbDir, 'AUTH.md'), '# Auth\n\nCorrected.\n');
    const out = await knowledgeQaReviewStep.apply(makeCtx(), {
      iteration: 0,
      previousIterations: [],
      detected,
      formValues: { review__1: 'Corrected.' },
      llmOutput: 'The edit is complete.',
    });
    expect(out.correctedCount).toBe(1);
    expect(out.kbWritten).toEqual([{ relPath: '.haive-data/knowledge_base/AUTH.md', section: '' }]);
  });

  it('accepts a code-derived correction saved to a different fitting KB page', async () => {
    const detected = detect({ passthrough: [], kbBefore: await snapshotKnowledgeBase(tmpRoot) });
    await mkdir(path.join(kbDir, 'QA'));
    await writeFile(path.join(kbDir, 'QA/delivery.md'), '# Delivery\n\nCorrected.\n');
    const out = await knowledgeQaReviewStep.apply(makeCtx(), {
      iteration: 0,
      previousIterations: [],
      detected,
      formValues: { review__0: 'Corrected.' },
      llmOutput: fence({
        kbWrites: [
          { relPath: 'QA/delivery.md', section: 'Delivery', question: 'How does delivery work?' },
        ],
      }),
    });
    expect(out.correctedCount).toBe(1);
    expect(out.kbWritten[0]!.relPath).toBe('.haive-data/knowledge_base/QA/delivery.md');
  });

  it('rejects an unrelated edit when the cited KB page still needs correction', async () => {
    await writeFile(path.join(kbDir, 'AUTH.md'), '# Old auth\n');
    const detected = detect({ passthrough: [], kbBefore: await snapshotKnowledgeBase(tmpRoot) });
    await writeFile(path.join(kbDir, 'OTHER.md'), '# Other change\n');
    await expect(
      knowledgeQaReviewStep.apply(makeCtx(), {
        iteration: 0,
        previousIterations: [],
        detected,
        formValues: { review__1: 'Correct auth.' },
        llmOutput: fence({ kbWrites: [{ relPath: 'OTHER.md', section: 'Other' }] }),
      }),
    ).rejects.toThrow(/not applied/i);
  });

  it.each([false, true])(
    'records an explicit already-correct item without counting it (shared page edited: %s)',
    async (editOtherAnswer) => {
      const original =
        '# Auth\n\n## Configuration\n\nAlready correct.\n\n## Delivery\n\nOld delivery.\n';
      await writeFile(path.join(kbDir, 'AUTH.md'), original);
      const reviewable = [detect().reviewable[1]!];
      if (editOtherAnswer)
        reviewable.push({
          ...detect().reviewable[0]!,
          source: 'kb',
          citedFile: '.haive-data/knowledge_base/AUTH.md',
          proposedWrite: undefined,
        });
      const detected = detect({
        reviewable,
        passthrough: [],
        kbBefore: await snapshotKnowledgeBase(tmpRoot),
      });
      if (editOtherAnswer)
        await writeFile(
          path.join(kbDir, 'AUTH.md'),
          original.replace('Old delivery.', 'Corrected delivery.'),
        );
      const out = await knowledgeQaReviewStep.apply(makeCtx(), {
        iteration: 0,
        previousIterations: [],
        detected,
        formValues: {
          review__1: 'Already correct.',
          ...(editOtherAnswer ? { review__0: 'Corrected delivery.' } : {}),
        },
        llmOutput: fence({
          kbWrites: editOtherAnswer
            ? [{ relPath: 'AUTH.md', section: 'Delivery', question: 'How does delivery work?' }]
            : [],
          kbUnchanged: [
            {
              question: 'Where is auth configured?',
              relPath: 'AUTH.md',
              reason: 'Existing KB already contains the owner clarification.',
            },
          ],
        }),
      });
      expect(out.correctedCount).toBe(editOtherAnswer ? 1 : 0);
      expect(out.newlyAnsweredCount).toBe(0);
      expect(out.kbWritten).toEqual(
        editOtherAnswer
          ? [{ relPath: '.haive-data/knowledge_base/AUTH.md', section: 'Delivery' }]
          : [],
      );
      expect(out.kbSkipped).toEqual([
        {
          relPath: '.haive-data/knowledge_base/AUTH.md',
          reason: 'Existing KB already contains the owner clarification.',
        },
      ]);
    },
  );

  it.each(['created', 'removed'] as const)(
    'rejects an already-correct claim for a page %s during the dispatch',
    async (change) => {
      if (change === 'removed') await writeFile(path.join(kbDir, 'AUTH.md'), '# Auth\n');
      const detected = detect({
        reviewable: [detect().reviewable[1]!],
        passthrough: [],
        kbBefore: await snapshotKnowledgeBase(tmpRoot),
      });
      if (change === 'removed') await rm(path.join(kbDir, 'AUTH.md'));
      else await writeFile(path.join(kbDir, 'AUTH.md'), '# Auth\n');
      await expect(
        knowledgeQaReviewStep.apply(makeCtx(), {
          iteration: 0,
          previousIterations: [],
          detected,
          formValues: { review__1: 'Already correct.' },
          llmOutput: fence({
            kbWrites: [],
            kbUnchanged: [
              {
                question: 'Where is auth configured?',
                relPath: 'AUTH.md',
                reason: 'Already correct.',
              },
            ],
          }),
        }),
      ).rejects.toThrow(/not applied/i);
    },
  );

  it('prepares and persists a fresh baseline on each won dispatch', async () => {
    const ctx = makeCtx();
    const saved: unknown[] = [];
    ctx.db = {
      update: () => ({
        set: (patch: { detectOutput: QaReviewDetect }) => {
          saved.push(structuredClone(patch.detectOutput));
          return { where: () => ({ returning: async () => [{ id: 's' }] }) };
        },
      }),
    } as unknown as typeof ctx.db;
    const detected = detect();
    await writeFile(path.join(kbDir, 'AUTH.md'), '# Before\n');
    await knowledgeQaReviewStep.llm!.prepareWorkspace!({ ctx, detected, formValues: {} });
    const before = { ...detected.kbBefore };
    await writeFile(path.join(kbDir, 'AUTH.md'), '# Retry baseline\n');
    await knowledgeQaReviewStep.llm!.prepareWorkspace!({ ctx, detected, formValues: {} });
    expect(detected.kbBefore).not.toEqual(before);
    expect(detected.kbBefore).toEqual(await snapshotKnowledgeBase(tmpRoot));
    expect(saved).toHaveLength(2);
    expect(saved[0]).toMatchObject({ kbBefore: before });
    expect(saved[1]).toMatchObject({ kbBefore: detected.kbBefore });
  });

  it('does not prepare files or persist a baseline after cancellation', async () => {
    const ctx = makeCtx();
    ctx.throwIfCancelled = () => {
      throw new Error('task cancelled');
    };
    const detected = detect();
    await expect(
      knowledgeQaReviewStep.llm!.prepareWorkspace!({ ctx, detected, formValues: {} }),
    ).rejects.toThrow('task cancelled');
    expect(detected.kbBefore).toBeUndefined();
  });

  it('leaves symlink targets outside the KB alone and refuses hard-link aliases', async () => {
    const outside = path.join(tmpRoot, 'private.md');
    await writeFile(outside, 'Private content');
    const outsideOwner = (await stat(outside)).uid;
    await symlink(outside, path.join(kbDir, 'alias.md'));
    await knowledgeQaReviewStep.llm!.prepareWorkspace!({
      ctx: makeCtx(),
      detected: detect(),
      formValues: {},
    });
    expect(await readFile(outside, 'utf8')).toBe('Private content');
    expect((await stat(outside)).uid).toBe(outsideOwner);
    await link(outside, path.join(kbDir, 'hard.md'));
    await expect(
      knowledgeQaReviewStep.llm!.prepareWorkspace!({
        ctx: makeCtx(),
        detected: detect(),
        formValues: {},
      }),
    ).rejects.toThrow(/aliased/i);
    expect(await readFile(outside, 'utf8')).toBe('Private content');
    expect((await stat(outside)).uid).toBe(outsideOwner);
  });

  it.skipIf(process.getuid?.() !== 0)(
    'repairs existing root KB ownership for a correction retry',
    async () => {
      await chown(tmpRoot, 1000, 1000);
      const protectedFiles = [
        '.haive-data/state/record.json',
        '.git/config',
        '.haive-data/knowledge_base/.git/config',
      ];
      for (const rel of protectedFiles) {
        await mkdir(path.dirname(path.join(tmpRoot, rel)), { recursive: true });
        await writeFile(path.join(tmpRoot, rel), 'Protected bytes', { mode: 0o600 });
      }
      const page = path.join(kbDir, 'AUTH.md');
      await writeFile(page, '# Auth\n', { mode: 0o644 });
      const agentWrite = () =>
        execFileSync(
          process.execPath,
          [
            '-e',
            'require("node:fs").appendFileSync(process.argv[1], "Corrected");require("node:fs").mkdirSync(process.argv[2]);',
            page,
            path.join(kbDir, 'QA'),
          ],
          { uid: 1000, gid: 1000, stdio: 'pipe' },
        );
      expect(agentWrite).toThrow(); // Captured 0644/0755 permission failure before handoff.
      const detected = detect({ passthrough: [] });
      await knowledgeQaReviewStep.llm!.prepareWorkspace!({
        ctx: makeCtx(),
        detected,
        formValues: {},
      });
      for (const rel of protectedFiles) {
        const info = await stat(path.join(tmpRoot, rel));
        expect(info.uid).toBe(0);
        expect(info.mode & 0o777).toBe(0o600);
        expect(await readFile(path.join(tmpRoot, rel), 'utf8')).toBe('Protected bytes');
      }
      expect((await stat(page)).uid).toBe(1000);
      expect((await stat(page)).mode & 0o777).toBe(0o644);
      expect((await stat(kbDir)).mode & 0o777).toBe(0o755);
      agentWrite();
      const out = await knowledgeQaReviewStep.apply(makeCtx(), {
        iteration: 0,
        previousIterations: [],
        detected,
        formValues: { review__1: 'Corrected.' },
        llmOutput: fence({ kbWrites: [{ relPath: 'AUTH.md', section: 'Auth' }] }),
      });
      expect(out.correctedCount).toBe(1);
      expect(await readFile(page, 'utf8')).toContain('Corrected');
    },
  );

  it('does not count a newly answered item just because another answer changed a KB page', async () => {
    const detected = detect({ kbBefore: await snapshotKnowledgeBase(tmpRoot) });
    await writeFile(path.join(kbDir, 'BUSINESS_LOGIC.md'), '# Corrected delivery only\n');
    await expect(
      knowledgeQaReviewStep.apply(makeCtx(), {
        iteration: 0,
        previousIterations: [],
        detected,
        formValues: { review__0: 'Corrected.', unanswered__0: 'Still needs saving.' },
        llmOutput: fence({
          kbWrites: [
            {
              relPath: 'BUSINESS_LOGIC.md',
              section: 'Delivery',
              question: 'How does delivery work?',
            },
          ],
        }),
      }),
    ).rejects.toThrow(/not applied/i);
  });

  it('refuses a missing claimed page and paths outside the KB', async () => {
    const detected = detect({ kbBefore: await snapshotKnowledgeBase(tmpRoot) });
    for (const relPath of ['AUTH.md', '../../outside.md']) {
      await expect(
        knowledgeQaReviewStep.apply(makeCtx(), {
          iteration: 0,
          previousIterations: [],
          detected,
          formValues: { review__1: 'Correct auth.' },
          llmOutput: fence({ kbWrites: [{ relPath, section: 'Auth' }] }),
        }),
      ).rejects.toThrow(/not applied/i);
    }
  });
});
