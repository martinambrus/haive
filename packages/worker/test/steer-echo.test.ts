import { describe, expect, it, vi } from 'vitest';
import { createCleanTranscriptBuffer } from '../src/queues/cli-exec/clean-transcript-buffer.js';
import { createStreamLogBuffer } from '../src/queues/cli-exec/stream-log-buffer.js';
import { createSteerEcho, formatSteerLine } from '../src/queues/cli-exec/steer-echo.js';

function harness() {
  const clean = createCleanTranscriptBuffer();
  const raw = createStreamLogBuffer();
  const publish = vi.fn();
  const echo = createSteerEcho({ invocationId: 'inv-1', clean, raw, publish });
  return { clean, raw, publish, echo };
}

describe('formatSteerLine', () => {
  // Mirrored verbatim by writeSteerLine in the web viewer, which draws the LIVE line off the
  // steer frame while this one serves the replay. If this string changes, that one must too.
  it('is the bracketed [you] annotation, bright blue, explicitly reset', () => {
    expect(formatSteerLine('focus on perf')).toBe('\r\n\x1b[94m[you] focus on perf\x1b[0m\r\n');
  });

  it('indents continuation lines under the tag so a multi-line steer cannot read as CLI output', () => {
    expect(formatSteerLine('one\ntwo')).toBe('\r\n\x1b[94m[you] one\n      two\x1b[0m\r\n');
    expect(formatSteerLine('one\r\ntwo')).toBe('\r\n\x1b[94m[you] one\n      two\x1b[0m\r\n');
  });
});

describe('createSteerEcho', () => {
  it('fans one human steer to the transcript, the raw buffer and the frame', () => {
    const { clean, raw, publish, echo } = harness();
    clean.pushModel('prose'); // a transcript needs model text to be persisted at all
    echo({ id: 'steer-1', text: 'look at auth' });

    const segs = clean.toTranscript()?.segments ?? [];
    expect(segs[1]).toMatchObject({ kind: 'user', text: 'look at auth', steerId: 'steer-1' });
    expect(raw.toString()).toContain('[you] look at auth');
    expect(publish).toHaveBeenCalledWith('inv-1', { id: 'steer-1', text: 'look at auth' });
  });

  // The soft-timeout wind-down rides the same channel so it reaches the model at the next
  // boundary, but 400 characters of "TIME BUDGET NEARLY SPENT…" is not something a person
  // said. Rendering it as the user's own turn would be a lie in the one place the transcript
  // exists to be honest.
  it('drops a system steer from all three surfaces', () => {
    const { clean, raw, publish, echo } = harness();
    clean.pushModel('prose');
    echo({ id: '', system: true, text: 'TIME BUDGET NEARLY SPENT.' });

    expect(clean.toTranscript()?.segments).toHaveLength(1);
    expect(raw.toString()).toBe('');
    expect(publish).not.toHaveBeenCalled();
  });

  // An empty id means "legacy bare-string steer", which IS human — the wind-down is told
  // apart by its own marker, not by the absence of an id.
  it('keeps an id-less human steer', () => {
    const { clean, raw, publish, echo } = harness();
    clean.pushModel('prose');
    echo({ id: '', text: 'legacy steer' });

    expect(clean.toTranscript()?.segments).toHaveLength(2);
    expect(raw.toString()).toContain('[you] legacy steer');
    expect(publish).toHaveBeenCalledWith('inv-1', { id: '', text: 'legacy steer' });
  });

  // Publishing the Raw line as a `stdout` frame would draw it twice (the viewer already
  // renders it from the steer frame) AND restamp the viewer's stall clock, silencing the
  // badge on exactly the frozen run someone is steering. The buffer push is neither.
  it('publishes exactly one frame — the steer frame, never a stdout chunk', () => {
    const { clean, publish, echo } = harness();
    clean.pushModel('prose');
    echo({ id: 'a', text: 'x' });
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
