import { describe, it, expect } from 'vitest';
import {
  failureBanner,
  invocationBanner,
  modelIdentityBanner,
  parkBanner,
  PAUSED_WAIT_TEXT,
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
const QUEUED_COPY = 'Queued — machine at capacity (2 parallel slots).';

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
    // The bug: the queued mark is written after queue.add, so a job picked up immediately had its
    // live "Waiting for AI analysis..." clobbered — a running CLI advertising "machine at
    // capacity" while the task read `running` in the listing.
    expect(
      invocationBanner(inv({ startedAt: '2026-07-24T15:44:12Z', statusMessage: QUEUED_COPY })),
    ).toEqual({ kind: 'running', text: QUEUED_COPY });
  });

  it('is null with no copy', () => {
    expect(invocationBanner(inv({ startedAt: '2026-07-24T15:44:12Z' }))).toBeNull();
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
