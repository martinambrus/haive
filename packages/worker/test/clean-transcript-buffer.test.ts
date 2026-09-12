import { describe, expect, it } from 'vitest';
import { createCleanTranscriptBuffer } from '../src/queues/cli-exec/clean-transcript-buffer.js';

describe('createCleanTranscriptBuffer', () => {
  it('merges consecutive model pushes into one segment', () => {
    const buf = createCleanTranscriptBuffer();
    buf.pushModel('first');
    buf.pushModel('second');
    const t = buf.toTranscript();
    expect(t?.segments).toHaveLength(1);
    expect(t?.segments[0]?.text).toBe('first\n\nsecond');
  });

  // The ordering is the whole reason this column exists: a steer read beside the prose that
  // answers it is the thing the steering.nudge events cannot reproduce.
  it('a steer between two model pushes opens a new segment and the prose resumes in a third', () => {
    const buf = createCleanTranscriptBuffer();
    buf.pushModel('before');
    buf.pushUser('look at auth', 'steer-1');
    buf.pushModel('after');
    const t = buf.toTranscript();
    expect(t?.segments.map((s) => s.kind)).toEqual(['model', 'user', 'model']);
    expect(t?.segments[1]).toMatchObject({ text: 'look at auth', steerId: 'steer-1' });
    expect(t?.segments[2]?.text).toBe('after');
  });

  it('markConsumed stamps the matching turn and ignores an unknown or empty id', () => {
    const buf = createCleanTranscriptBuffer();
    buf.pushModel('prose');
    buf.pushUser('one', 'a');
    buf.pushUser('two', 'b');
    buf.markConsumed('b');
    buf.markConsumed('nope');
    buf.markConsumed('');
    const t = buf.toTranscript();
    expect(t?.segments[1]?.consumed).toBeUndefined();
    expect(t?.segments[2]?.consumed).toBe(true);
  });

  describe('toTranscript', () => {
    it('is null for an empty buffer', () => {
      expect(createCleanTranscriptBuffer().toTranscript()).toBeNull();
    });

    // A transcript is the ONLY thing the viewer renders once present, so one holding user
    // turns alone would hide an answer that only raw_output carries — which is exactly the
    // gemini / plain-text case, where prose never travels through onProseText.
    it('is null when there are steers but no model prose', () => {
      const buf = createCleanTranscriptBuffer();
      buf.pushUser('steer with no prose', 'a');
      expect(buf.toTranscript()).toBeNull();
    });

    it('is non-null as soon as one model segment exists', () => {
      const buf = createCleanTranscriptBuffer();
      buf.pushModel('hi');
      expect(buf.toTranscript()?.segments).toHaveLength(1);
    });
  });

  describe('budget', () => {
    it('drops whole middle segments and states the loss rather than truncating one', () => {
      const buf = createCleanTranscriptBuffer({ maxChars: 40 });
      buf.pushModel('a'.repeat(20));
      buf.pushUser('s1', 'a');
      buf.pushModel('b'.repeat(20));
      buf.pushUser('s2', 'b');
      buf.pushModel('c'.repeat(20));
      const t = buf.toTranscript();
      expect(t?.elided?.segments).toBeGreaterThan(0);
      expect(t?.elided?.chars).toBeGreaterThan(0);
      expect(t?.elided?.afterIndex).toBe(0);
      // Nothing is ever cut mid-turn: every surviving segment is whole.
      for (const seg of t?.segments ?? []) {
        expect([20, 2]).toContain(seg.text.length);
      }
    });

    // A steer is at most 8 KiB and is the entire reason the column exists, so model prose is
    // what gives way first.
    it('keeps user turns while model segments are still droppable', () => {
      const buf = createCleanTranscriptBuffer({ maxChars: 30 });
      buf.pushModel('a'.repeat(20));
      buf.pushUser('s1', 'a');
      buf.pushModel('b'.repeat(20));
      buf.pushUser('s2', 'b');
      buf.pushModel('c'.repeat(20));
      const kinds = buf.toTranscript()?.segments.map((s) => s.kind);
      expect(kinds).toContain('user');
    });

    it('leaves a lone oversized segment whole and reports no elision', () => {
      const buf = createCleanTranscriptBuffer({ maxChars: 10 });
      buf.pushModel('x'.repeat(500));
      const t = buf.toTranscript();
      expect(t?.segments).toHaveLength(1);
      expect(t?.segments[0]?.text).toHaveLength(500);
      expect(t?.elided).toBeUndefined();
    });

    it('reports no elision at all while the run stays inside the budget', () => {
      const buf = createCleanTranscriptBuffer();
      buf.pushModel('small');
      buf.pushUser('steer', 'a');
      expect(buf.toTranscript()?.elided).toBeUndefined();
    });
  });

  it('ignores empty pushes', () => {
    const buf = createCleanTranscriptBuffer();
    buf.pushModel('');
    buf.pushUser('', 'a');
    expect(buf.toTranscript()).toBeNull();
  });
});
