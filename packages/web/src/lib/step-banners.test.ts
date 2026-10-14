import { describe, it, expect } from 'vitest';
import {
  archiveExpansionBanner,
  deadBanner,
  failureBanner,
  invocationBanner,
  isTaskDead,
  leftMergeBanners,
  modelIdentityBanner,
  parkBanner,
  PAUSED_WAIT_TEXT,
  QUEUED_WAIT_TEXT,
  type DeadStepRow,
  type StepBannerRow,
  type InvocationBannerRow,
} from './step-banners';

const step = (over: Partial<StepBannerRow> = {}): StepBannerRow => ({
  status: 'pending',
  statusMessage: null,
  errorMessage: null,
  waitingStartedAt: null,
  ...over,
});

const PARK_COPY = 'Waiting for a free runtime slot — #1 of 2 waiting (8192 MB of 10941 MB in use)';
// The one line a queued invocation can carry: the runtime-holder reserve's, written at defer
// time by a gate that knows why it is holding the job. Nothing is written at enqueue any more —
// that mark named capacity it could not know and split one fan-out across two sentences.
const QUEUED_COPY =
  'Waiting — 2 tasks with a live environment have priority for the CLI slots. ' +
  'Your run starts automatically.';

describe('parkBanner', () => {
  it('shows while the step is parked', () => {
    const parked = step({ statusMessage: PARK_COPY, waitingStartedAt: '2026-07-24T13:00:00Z' });
    expect(parkBanner(parked, { taskEnded: false })).toEqual({ text: PARK_COPY });
  });

  it('hides once the park is over, even though the copy survives', () => {
    // The bug: a park loop whose chain ended cannot clear its own line, so this row kept
    // advertising a live wait beside the task's real one — two amber banners on one task.
    const leftover = step({ statusMessage: PARK_COPY, waitingStartedAt: null });
    expect(parkBanner(leftover, { taskEnded: false })).toBeNull();
  });

  it('says paused, not "machine at capacity", while execution is paused', () => {
    // The bug: with the global switch on, a parked step still advertised its stored queue line,
    // so the page promised a runtime slot that nothing was handing out until the switch flipped.
    const parked = step({ statusMessage: PARK_COPY, waitingStartedAt: '2026-07-24T13:00:00Z' });
    expect(parkBanner(parked, { taskEnded: false, paused: true })).toEqual({
      text: PAUSED_WAIT_TEXT,
    });
  });

  it('still says paused when the park never wrote a line', () => {
    const parked = step({ statusMessage: null, waitingStartedAt: '2026-07-24T13:00:00Z' });
    expect(parkBanner(parked, { taskEnded: false, paused: true })).toEqual({
      text: PAUSED_WAIT_TEXT,
    });
  });

  it('pause does not resurrect a banner for an unparked or terminal step', () => {
    const unparked = step({ statusMessage: PARK_COPY, waitingStartedAt: null });
    expect(parkBanner(unparked, { taskEnded: false, paused: true })).toBeNull();
    const parked = step({ statusMessage: PARK_COPY, waitingStartedAt: '2026-07-24T13:00:00Z' });
    expect(parkBanner(parked, { taskEnded: true, paused: true })).toBeNull();
  });

  it('hides on a terminal task that still holds a marker', () => {
    const parked = step({ statusMessage: PARK_COPY, waitingStartedAt: '2026-07-24T13:00:00Z' });
    expect(parkBanner(parked, { taskEnded: true })).toBeNull();
  });

  it('hides for any status other than pending', () => {
    for (const status of ['running', 'waiting_cli', 'waiting_form', 'done', 'failed']) {
      const row = step({
        status,
        statusMessage: PARK_COPY,
        waitingStartedAt: '2026-07-24T13:00:00Z',
      });
      expect(parkBanner(row, { taskEnded: false })).toBeNull();
    }
  });

  it('hides on a dead task that still holds a marker, paused or not', () => {
    // A dead task is not ended, and its park loop is gone: the marker and its copy are all that is
    // left, which is the copy-not-state trap the rest of this file exists to close.
    const parked = step({ statusMessage: PARK_COPY, waitingStartedAt: '2026-07-24T13:00:00Z' });
    expect(parkBanner(parked, { taskEnded: false, dead: true })).toBeNull();
    expect(parkBanner(parked, { taskEnded: false, dead: true, paused: true })).toBeNull();
    expect(parkBanner(parked, { taskEnded: false, dead: false })).toEqual({ text: PARK_COPY });
  });
});

describe('failureBanner', () => {
  it('shows on a failed step', () => {
    const failed = step({ status: 'failed', errorMessage: 'Stopped by user' });
    expect(failureBanner(failed)).toEqual({ text: 'Stopped by user' });
  });

  it('hides on a row that ended well, where the text is stale or a diagnosis', () => {
    // Two reasons, one rule. Stale: a step that failed on one attempt and succeeded later kept
    // its error text and rendered a red "cli invocation failed" panel with a Retry button, reading
    // as a failure beside the task's real work. Deliberate: fixLoopOnError writes done TOGETHER
    // with errorMessage to route a diagnosis back to implementation.
    for (const status of ['done', 'skipped']) {
      const ended = step({ status, errorMessage: 'cli invocation failed: orphaned by a restart' });
      expect(failureBanner(ended)).toBeNull();
    }
  });

  it('still shows while the step is live', () => {
    for (const status of ['running', 'waiting_cli', 'pending']) {
      expect(failureBanner(step({ status, errorMessage: 'boom' }))).toEqual({ text: 'boom' });
    }
  });

  it('is null with no copy to show', () => {
    expect(failureBanner(step({ status: 'failed' }))).toBeNull();
  });
});

describe('invocationBanner', () => {
  const inv = (over: Partial<InvocationBannerRow> = {}): InvocationBannerRow => ({
    startedAt: null,
    statusMessage: null,
    ...over,
  });

  it('calls an unstarted invocation queued', () => {
    expect(invocationBanner(inv({ statusMessage: QUEUED_COPY }))).toEqual({
      kind: 'queued',
      text: QUEUED_COPY,
    });
  });

  it('calls a started invocation running, whatever its copy says', () => {
    // The bug: a gate's waiting line races the run itself, so a job picked up immediately had
    // its live "Waiting for AI analysis..." clobbered — a running CLI advertising that it was
    // still waiting for a slot while the task read `running` in the listing.
    expect(
      invocationBanner(inv({ startedAt: '2026-07-24T15:44:12Z', statusMessage: QUEUED_COPY })),
    ).toEqual({ kind: 'running', text: QUEUED_COPY });
  });

  it('is null with no copy, but only for a STARTED run', () => {
    expect(invocationBanner(inv({ startedAt: '2026-07-24T15:44:12Z' }))).toBeNull();
  });

  it('speaks for a queued run whose queue line was never written', () => {
    // The common case, and since the enqueue mark was dropped it is nearly the only one: a
    // queued run carries no copy unless a gate deferred it for a reason it could prove.
    // Returning null there let the terminal fall through to its STEP's live status — a queued
    // verifier rendering another terminal's work in running-blue.
    expect(invocationBanner(inv())).toEqual({ kind: 'queued', text: QUEUED_WAIT_TEXT });
  });

  it('relabels a QUEUED invocation while paused', () => {
    expect(invocationBanner(inv({ statusMessage: QUEUED_COPY }), { paused: true })).toEqual({
      kind: 'queued',
      text: PAUSED_WAIT_TEXT,
    });
  });

  it('leaves a STARTED invocation alone while paused', () => {
    // Pause gates job pickup, never work in flight: this sandbox is still running and still
    // streaming. Relabelling it would tell the user their live run had stopped.
    const running = inv({ startedAt: '2026-07-24T15:44:12Z', statusMessage: 'Running: pnpm test' });
    expect(invocationBanner(running, { paused: true })).toEqual({
      kind: 'running',
      text: 'Running: pnpm test',
    });
  });

  it('speaks for a queued invocation that never wrote a status line', () => {
    expect(invocationBanner(inv(), { paused: true })).toEqual({
      kind: 'queued',
      text: PAUSED_WAIT_TEXT,
    });
  });
});

describe('modelIdentityBanner', () => {
  it('warns on the measured Z.AI swap', () => {
    // Asked glm-5.2[1m], api.z.ai served glm-5.3 — the case the feature exists for.
    expect(
      modelIdentityBanner({ requested: 'glm-5.2[1m]', served: 'glm-5.3', match: 'differs' }),
    ).toEqual({ text: 'Model mismatch: configured glm-5.2[1m], but glm-5.3 answered.' });
  });

  it('stays silent when the endpoint echoed what was asked', () => {
    expect(
      modelIdentityBanner({
        requested: 'claude-sonnet-4-6',
        served: 'claude-sonnet-4-6',
        match: 'exact',
      }),
    ).toBeNull();
  });

  it('stays silent for CLIs that report no model at all', () => {
    // codex and amp are permanently 'unknown'. A banner there would be unactionable
    // and would render "we could not check" as if it were "something is wrong".
    expect(
      modelIdentityBanner({ requested: 'gpt-5.6-sol', served: null, match: 'unknown' }),
    ).toBeNull();
  });

  it('is silent when there is no identity at all', () => {
    expect(modelIdentityBanner(null)).toBeNull();
    expect(modelIdentityBanner(undefined)).toBeNull();
  });

  it('trusts `match` rather than re-comparing the strings', () => {
    // The comparison happens once, where the evidence is. If a caller could re-derive
    // it here the rule would have two homes and could drift; this asserts it does not.
    expect(
      modelIdentityBanner({ requested: 'same-model', served: 'same-model', match: 'differs' }),
    ).not.toBeNull();
  });
});

describe('archiveExpansionBanner', () => {
  const NOTE = '2 archive members were not extracted (path too long or too deep to store): a, b';
  const STAMP = '2026-09-23T12:00:00.000Z';

  it('shows the note of an archive the worker expanded', () => {
    expect(archiveExpansionBanner({ expandedAt: STAMP, expansionNote: NOTE })).toEqual({
      text: NOTE,
    });
  });

  it('says nothing for an archive that expanded in full', () => {
    expect(archiveExpansionBanner({ expandedAt: STAMP, expansionNote: null })).toBeNull();
    expect(archiveExpansionBanner({ expandedAt: STAMP, expansionNote: '' })).toBeNull();
  });

  it('shows no note the stamp does not vouch for', () => {
    // Nothing writes one today, since the worker stamps both in one UPDATE. But a path that
    // cleared the stamp to force a re-expansion would leave the old line describing a run
    // that is about to be redone.
    expect(archiveExpansionBanner({ expandedAt: null, expansionNote: NOTE })).toBeNull();
  });

  it('says nothing for an attachment from an api that predates the fields', () => {
    expect(archiveExpansionBanner({})).toBeNull();
  });
});

describe('leftMergeBanners', () => {
  const opened = {
    eventType: 'merge.left_open',
    payload: { dir: '/repo', ref: 'feat/a', head: 'h1', mergeHead: 'm1' },
  };
  const settled = (outcome: string, reason: string) => ({
    eventType: 'merge.left_open_settled',
    payload: { dir: '/repo', mergeHead: 'm1', outcome, reason },
  });

  it('shows an unsettled merge on a cancelled task, offering the abort', () => {
    const [b] = leftMergeBanners([opened], { taskStatus: 'cancelled' });
    expect(b).toMatchObject({ dir: '/repo', ref: 'feat/a', canAbort: true });
    expect(b?.text).toContain('feat/a');
    expect(b?.text).toContain('/repo');
  });

  it('shows the settled outcome instead once one exists, with no abort', () => {
    const [b] = leftMergeBanners([opened, settled('moved', 'The merge changed since.')], {
      taskStatus: 'cancelled',
    });
    expect(b?.canAbort).toBe(false);
    expect(b?.text).toContain('The merge changed since.');
  });

  it('keeps the abort offered after a refused attempt, saying why it was refused', () => {
    const [b] = leftMergeBanners([opened, settled('refused', 'Another task is merging here.')], {
      taskStatus: 'cancelled',
    });
    expect(b).toMatchObject({ canAbort: true, refusals: 1 });
    expect(b?.text).toContain('Another task is merging here.');
  });

  it('keeps two reports of one directory apart by the commit being merged', () => {
    const second = { ...opened, payload: { ...opened.payload, mergeHead: 'm2' } };
    const banners = leftMergeBanners([opened, second], { taskStatus: 'cancelled' });
    expect(banners.map((b) => b.mergeHead)).toEqual(['m1', 'm2']);
    expect(new Set(banners.map((b) => b.key)).size).toBe(2);
  });

  it('words each outcome differently', () => {
    const text = (o: string) =>
      leftMergeBanners([opened, settled(o, 'why')], { taskStatus: 'cancelled' })[0]!.text;
    expect(new Set(['aborted', 'moved', 'aborted-by-next'].map(text)).size).toBe(3);
  });

  it('shows nothing for a task that is not cancelled, whatever the events say', () => {
    expect(leftMergeBanners([opened], { taskStatus: 'failed' })).toEqual([]);
  });

  it('shows nothing without an event', () => {
    expect(leftMergeBanners([], { taskStatus: 'cancelled' })).toEqual([]);
  });
});

const DEAD_AT = '2026-10-14T10:00:00.000Z';
const LIVE_STATUSES = ['created', 'queued', 'running', 'waiting_user', 'waiting_pr', 'failed'];

describe('isTaskDead', () => {
  it('is true for any task that is not finished and has dead_at set', () => {
    for (const status of LIVE_STATUSES) {
      expect(isTaskDead({ status, deadAt: DEAD_AT })).toBe(true);
    }
  });

  it('takes a Date as well as the ISO string the api sends', () => {
    expect(isTaskDead({ status: 'running', deadAt: new Date(DEAD_AT) })).toBe(true);
  });

  it('is false once the task is cancelled or completed, whatever dead_at says', () => {
    for (const status of ['cancelled', 'completed']) {
      expect(isTaskDead({ status, deadAt: DEAD_AT })).toBe(false);
    }
  });

  it('is false without dead_at, including from an api that predates the column', () => {
    expect(isTaskDead({ status: 'running', deadAt: null })).toBe(false);
    expect(isTaskDead({ status: 'running' })).toBe(false);
  });

  it('reads the structural column and never the dead_reason copy', () => {
    // NEGATIVE CONTROL: a version keyed on dead_reason fails both halves, the copy-only row and
    // the stamp-only row.
    const copyOnly = {
      status: 'running',
      deadAt: null,
      deadReason: 'the run list names a step this install does not register: module.x.y',
    };
    const stampOnly = { status: 'running', deadAt: DEAD_AT, deadReason: null };
    expect(isTaskDead(copyOnly)).toBe(false);
    expect(isTaskDead(stampOnly)).toBe(true);
  });
});

describe('deadBanner', () => {
  const task = { status: 'waiting_user', deadAt: DEAD_AT };
  const moduleStep = (
    stepId: string,
    over: Partial<NonNullable<DeadStepRow['module']>> = {},
  ): DeadStepRow => ({
    stepId,
    module: { id: 'statistics', name: 'Statistics', missing: true, ...over },
  });
  const plain = (stepId: string): DeadStepRow => ({ stepId, module: null });

  it('names the module that is not installed, and how to get the task moving again', () => {
    expect(deadBanner(task, [moduleStep('module.statistics.collect')])).toEqual({
      text:
        'This task needs the module `Statistics`, which is not installed. Nothing runs on it ' +
        'until the module is installed again and the worker restarts; until then you can only ' +
        'cancel it.',
    });
  });

  it('falls back to the module id when the module row is gone and has no name', () => {
    const text = deadBanner(task, [moduleStep('module.statistics.collect', { name: null })])?.text;
    expect(text).toContain('the module `statistics`, which is not installed');
  });

  it('names a module once however many of its steps are unresolved', () => {
    const text = deadBanner(task, [
      moduleStep('module.statistics.collect'),
      moduleStep('module.statistics.report'),
    ])?.text;
    expect(text?.match(/`Statistics`/g)).toHaveLength(1);
  });

  it('says an installed module no longer provides the step, not that it is missing', () => {
    const text = deadBanner(task, [
      moduleStep('module.statistics.collect', { missing: false }),
    ])?.text;
    expect(text).toContain(
      'the module `Statistics` no longer provides `module.statistics.collect`',
    );
    expect(text).not.toContain('not installed');
  });

  it('lists the steps one module stopped providing in a single sentence', () => {
    const text = deadBanner(task, [
      moduleStep('module.statistics.collect', { missing: false }),
      moduleStep('module.statistics.report', { missing: false }),
    ])?.text;
    expect(text).toContain(
      'the module `Statistics` no longer provides `module.statistics.collect` and `module.statistics.report`',
    );
  });

  it('says a custom prompt step cannot be read from what the task was created with', () => {
    const text = deadBanner(task, [plain('custom.review.audit')])?.text;
    expect(text).toContain(
      'its prompt step `custom.review.audit` cannot be read from what the task was created with; cancel it',
    );
  });

  it('says a core step id is one this install does not have', () => {
    const text = deadBanner(task, [plain('99-renamed')])?.text;
    expect(text).toContain('its run list names steps this install does not have: `99-renamed`');
  });

  it('files an id no grammar reads with the core ones', () => {
    const text = deadBanner(task, [plain('Not A Step')])?.text;
    expect(text).toContain('does not have: `Not A Step`');
  });

  it('gives one generic sentence when the dead event listed nothing', () => {
    expect(deadBanner(task, [])).toEqual({
      text: 'This task is dead: a step it needs is no longer available. You can only cancel it.',
    });
  });

  it('puts several unresolved steps in ONE banner, one sentence per kind', () => {
    const banner = deadBanner(task, [
      moduleStep('module.statistics.collect'),
      moduleStep('module.billing.invoice', { id: 'billing', name: 'Billing', missing: false }),
      plain('custom.review.audit'),
      plain('99-renamed'),
      plain('98-renamed'),
    ]);
    const text = banner?.text ?? '';
    expect(text).toContain('the module `Statistics`, which is not installed');
    expect(text).toContain('the module `Billing` no longer provides `module.billing.invoice`');
    expect(text).toContain('its prompt step `custom.review.audit` cannot be read');
    expect(text).toContain('does not have: `99-renamed` and `98-renamed`');
    expect(text.split('\n\n')).toHaveLength(4);
  });

  it('lists several missing modules in one sentence', () => {
    const text = deadBanner(task, [
      moduleStep('module.statistics.collect'),
      moduleStep('module.billing.invoice', { id: 'billing', name: 'Billing' }),
    ])?.text;
    expect(text).toContain('needs the modules `Statistics` and `Billing`, which are not installed');
    expect(text).toContain('until they are installed again');
  });

  it('keeps a backtick in a module name from closing the code span', () => {
    const text = deadBanner(task, [
      moduleStep('module.odd.step', { id: 'odd', name: 'a`b' }),
    ])?.text;
    expect(text).toContain('the module ``a`b``, which is not installed');
  });

  it('is shown for a failed task as well: dead is not a status', () => {
    expect(deadBanner({ status: 'failed', deadAt: DEAD_AT }, [])).not.toBeNull();
  });

  it('is null for a cancelled or completed task that still carries dead_at', () => {
    for (const status of ['cancelled', 'completed']) {
      expect(
        deadBanner({ status, deadAt: DEAD_AT }, [moduleStep('module.statistics.collect')]),
      ).toBeNull();
    }
  });

  it('is null without dead_at, even with a dead_reason set', () => {
    // NEGATIVE CONTROL: copy that outlived its stamp. Only the structural column tells it from a
    // dead task, and a version keyed on dead_reason shows the banner here.
    const copyOnly = {
      status: 'running',
      deadAt: null,
      deadReason: 'the run list names a step this install does not register: module.x.y',
    };
    expect(deadBanner(copyOnly, [moduleStep('module.statistics.collect')])).toBeNull();
  });

  it('shows with dead_at and no dead_reason at all', () => {
    const stampOnly = { status: 'running', deadAt: DEAD_AT, deadReason: null };
    expect(deadBanner(stampOnly, [moduleStep('module.statistics.collect')])).not.toBeNull();
  });
});
