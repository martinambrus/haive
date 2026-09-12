import { describe, expect, it } from 'vitest';
import {
  appendModelText,
  appendUserTurn,
  applySteerFrame,
  buildReplayTranscript,
  hasModelText,
  markPendingUnconsumed,
  markSteerConsumed,
  parseCleanTranscript,
  type TranscriptSegment,
} from './clean-transcript';

const user = (id: string, text: string, status: 'sent' | 'consumed' = 'sent'): TranscriptSegment =>
  ({ kind: 'user', id, text, status }) as TranscriptSegment;

describe('appendModelText', () => {
  it('coalesces consecutive chunks into one body, separated by a blank line', () => {
    let segs = appendModelText([], 'first turn');
    segs = appendModelText(segs, 'second turn');
    expect(segs).toHaveLength(1);
    expect(segs[0]).toEqual({ kind: 'model', text: 'first turn\n\nsecond turn' });
  });

  it('does not double the separator when the previous chunk already ended with one', () => {
    expect(appendModelText([{ kind: 'model', text: 'a\n\n' }], 'b')[0]).toEqual({
      kind: 'model',
      text: 'a\n\nb',
    });
    expect(appendModelText([{ kind: 'model', text: 'a\n' }], 'b')[0]).toEqual({
      kind: 'model',
      text: 'a\n\nb',
    });
  });

  // The whole point of the segment model: a steer breaks the run so the prose beneath it
  // reads as the reply, instead of being glued onto the paragraph before it.
  it('starts a fresh segment after a user turn instead of coalescing across it', () => {
    let segs = appendModelText([], 'before');
    segs = appendUserTurn(segs, { id: 'a', text: 'look at auth', status: 'sent' });
    segs = appendModelText(segs, 'after');
    expect(segs.map((s) => s.kind)).toEqual(['model', 'user', 'model']);
    expect(segs[2]).toEqual({ kind: 'model', text: 'after' });
  });

  it('strips carriage returns at append time', () => {
    expect(appendModelText([], 'a\r\nb')[0]).toEqual({ kind: 'model', text: 'a\nb' });
  });

  it('returns the same array for an empty chunk', () => {
    const segs: TranscriptSegment[] = [{ kind: 'model', text: 'x' }];
    expect(appendModelText(segs, '')).toBe(segs);
    expect(appendModelText(segs, '\r')).toBe(segs);
  });
});

describe('appendUserTurn', () => {
  // The race that produced a real double-render: the worker publishes the steer frame the
  // moment the text hits stdin, which often beats the POST's own response, so the frame has
  // already added the turn by the time the sender appends it optimistically.
  it('is a no-op when a turn with that id is already present', () => {
    const segs = applySteerFrame([], { id: 'a', text: 'from the frame' });
    expect(appendUserTurn(segs, { id: 'a', text: 'from the frame', status: 'sent' })).toBe(segs);
  });

  it('does not resurrect a turn the frame has already had consumed', () => {
    const segs: TranscriptSegment[] = [user('a', 'x', 'consumed')];
    const next = appendUserTurn(segs, { id: 'a', text: 'x', status: 'sent' });
    expect(next).toBe(segs);
    expect((next[0] as { status: string }).status).toBe('consumed');
  });

  // A POST that threw published no frame, so there is nothing to collide with.
  it('still appends a rejected turn', () => {
    const segs = appendUserTurn([], { id: 'b', text: 'x', status: 'error', error: 'too late' });
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ status: 'error', error: 'too late' });
  });
});

describe('applySteerFrame', () => {
  // The sender appends optimistically AND the API replays the stream from id 0 on every
  // connect, so a plain append would render each steer twice for whoever sent it.
  it('does not duplicate a turn the sender already added optimistically', () => {
    const segs = appendUserTurn([], { id: 'a', text: 'look at auth', status: 'sent' });
    expect(applySteerFrame(segs, { id: 'a', text: 'look at auth' })).toBe(segs);
  });

  it('does not reset a turn that has already been consumed', () => {
    const segs: TranscriptSegment[] = [user('a', 'x', 'consumed')];
    const next = applySteerFrame(segs, { id: 'a', text: 'x' });
    expect(next).toBe(segs);
    expect((next[0] as { status: string }).status).toBe('consumed');
  });

  it('appends when the id is unseen — a second tab, or a terminal opened mid-run', () => {
    const segs = applySteerFrame([{ kind: 'model', text: 'hi' }], { id: 'b', text: 'focus perf' });
    expect(segs).toHaveLength(2);
    expect(segs[1]).toEqual({ kind: 'user', id: 'b', text: 'focus perf', status: 'sent' });
  });

  it('dedupes an id-less steer on its text, since there is no id to correlate', () => {
    const first = applySteerFrame([], { id: '', text: 'legacy steer' });
    expect(first).toHaveLength(1);
    expect(applySteerFrame(first, { id: '', text: 'legacy steer' })).toBe(first);
  });
});

describe('markSteerConsumed', () => {
  it('flips only the matching sent turn', () => {
    const segs: TranscriptSegment[] = [user('a', 'one'), user('b', 'two')];
    const next = markSteerConsumed(segs, 'b');
    expect((next[0] as { status: string }).status).toBe('sent');
    expect((next[1] as { status: string }).status).toBe('consumed');
  });

  // Identity stability is what keeps the memoized transcript from re-rendering on every
  // unrelated or replayed frame.
  it('returns the same array when nothing matches', () => {
    const segs: TranscriptSegment[] = [user('a', 'one', 'consumed')];
    expect(markSteerConsumed(segs, 'a')).toBe(segs);
    expect(markSteerConsumed(segs, 'zz')).toBe(segs);
    expect(markSteerConsumed(segs, '')).toBe(segs);
  });
});

describe('markPendingUnconsumed', () => {
  it('flips every still-sent turn when the run ends', () => {
    const segs: TranscriptSegment[] = [user('a', 'one'), user('b', 'two', 'consumed')];
    const next = markPendingUnconsumed(segs);
    expect((next[0] as { status: string }).status).toBe('unconsumed');
    expect((next[1] as { status: string }).status).toBe('consumed');
  });

  it('returns the same array when nothing is pending', () => {
    const segs: TranscriptSegment[] = [user('a', 'one', 'consumed')];
    expect(markPendingUnconsumed(segs)).toBe(segs);
  });
});

describe('hasModelText', () => {
  // "Clean is empty" must keep meaning "the MODEL has said nothing" — that is what the Raw
  // auto-switch is for, and a transcript holding only the user's own turn is still that run.
  it('is false for user turns alone and for whitespace-only prose', () => {
    expect(hasModelText([user('a', 'steer')])).toBe(false);
    expect(hasModelText([{ kind: 'model', text: '   \n' }])).toBe(false);
    expect(hasModelText([])).toBe(false);
  });

  it('is true once any prose lands', () => {
    expect(hasModelText([user('a', 'steer'), { kind: 'model', text: 'hi' }])).toBe(true);
  });
});

describe('parseCleanTranscript', () => {
  it('maps steerId to id and consumed to a status', () => {
    const parsed = parseCleanTranscript({
      segments: [
        { kind: 'model', text: 'before', at: 1 },
        { kind: 'user', text: 'steer', at: 2, steerId: 'a', consumed: true },
        { kind: 'user', text: 'later', at: 3, steerId: 'b' },
      ],
    });
    expect(parsed).toEqual([
      { kind: 'model', text: 'before' },
      { kind: 'user', id: 'a', text: 'steer', status: 'consumed' },
      // Absent `consumed` is not evidence it was applied.
      { kind: 'user', id: 'b', text: 'later', status: 'historical' },
    ]);
  });

  it('returns null for anything it does not recognise, so one bad row cannot blank a replay', () => {
    expect(parseCleanTranscript(null)).toBeNull();
    expect(parseCleanTranscript(undefined)).toBeNull();
    expect(parseCleanTranscript({ segments: [] })).toBeNull();
    expect(parseCleanTranscript({ segments: 'nope' })).toBeNull();
    expect(parseCleanTranscript({ segments: [{ kind: 'ghost', text: 'x', at: 1 }] })).toBeNull();
    expect(parseCleanTranscript({ segments: [{ kind: 'model', text: 7, at: 1 }] })).toBeNull();
  });
});

describe('buildReplayTranscript', () => {
  const restored = [{ id: 'history:1', text: 'old steer', status: 'historical' as const }];

  it('prefers the persisted transcript and ignores the restored events', () => {
    const out = buildReplayTranscript({
      transcript: { segments: [{ kind: 'model', text: 'stored', at: 1 }] },
      cleanOutput: 'fallback',
      restored,
    });
    expect(out).toEqual([{ kind: 'model', text: 'stored' }]);
  });

  it('falls back to the plain prose with the steers grouped above it', () => {
    const out = buildReplayTranscript({ transcript: null, cleanOutput: 'prose\r\n', restored });
    expect(out).toEqual([
      { kind: 'history', steers: restored },
      { kind: 'model', text: 'prose\n' },
    ]);
  });

  it('is empty when there is nothing at all', () => {
    expect(buildReplayTranscript({ transcript: null, cleanOutput: '', restored: [] })).toEqual([]);
  });
});
