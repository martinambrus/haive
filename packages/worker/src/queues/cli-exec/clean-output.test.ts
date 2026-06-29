import { describe, it, expect } from 'vitest';
import { looksLikeCliProtocol, looksLikeJson, proseForClean } from './clean-output.js';

// The exact head of a real leaked row (claude-stream-json, model kimi-k2.7-code):
// a killed run whose raw_output became the full NDJSON stream.
const CLAUDE_INIT_NDJSON =
  '{"type":"system","subtype":"init","cwd":"/x","session_id":"a","model":"kimi-k2.7-code:cloud"}\n' +
  '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n';

const CODEX_JSONL =
  '{"type":"thread.started","thread_id":"019f"}\n' +
  '{"type":"turn.started"}\n' +
  '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n';

describe('looksLikeCliProtocol', () => {
  it('detects the claude-stream-json init event', () => {
    expect(looksLikeCliProtocol(CLAUDE_INIT_NDJSON)).toBe(true);
  });

  it('detects the codex-jsonl init event', () => {
    expect(looksLikeCliProtocol(CODEX_JSONL)).toBe(true);
  });

  it('detects a generic >=2 typed-event NDJSON stream without an init prefix', () => {
    const raw =
      '{"type":"assistant","message":{"content":[]}}\n' +
      '{"type":"result","subtype":"success","result":"x"}\n';
    expect(looksLikeCliProtocol(raw)).toBe(true);
  });

  it('does NOT treat a single JSON object (a model answering in JSON) as protocol', () => {
    expect(looksLikeCliProtocol('{"type":"bug","severity":"high","file":"a.ts"}')).toBe(false);
  });

  it('does NOT treat plain prose as protocol', () => {
    expect(looksLikeCliProtocol("I'll verify the spec's claims against the codebase first.")).toBe(
      false,
    );
  });

  it('does NOT treat prose that merely mentions {"type" inline as protocol', () => {
    expect(looksLikeCliProtocol('The event uses a {"type": "x"} shape, as shown above.')).toBe(
      false,
    );
  });
});

describe('looksLikeJson', () => {
  it('is true for a JSON object (gemini wrapper)', () => {
    expect(looksLikeJson('{"response":"hi","stats":{"tokens":5}}')).toBe(true);
  });

  it('is true for a JSON array', () => {
    expect(looksLikeJson('[1, 2, 3]')).toBe(true);
  });

  it('is false for plain text (old-binary fallthrough)', () => {
    expect(looksLikeJson('Here is the answer in plain text.')).toBe(false);
  });

  it('is false for invalid/truncated JSON', () => {
    expect(looksLikeJson('{"response": "tru')).toBe(false);
  });
});

describe('proseForClean', () => {
  it('prefers extracted prose when present', () => {
    expect(proseForClean('the model said this', CLAUDE_INIT_NDJSON)).toBe('the model said this');
  });

  it('empties machine protocol when there is no prose', () => {
    expect(proseForClean('', CLAUDE_INIT_NDJSON)).toBe('');
    expect(proseForClean(null, CODEX_JSONL)).toBe('');
    expect(proseForClean(undefined, CLAUDE_INIT_NDJSON)).toBe('');
  });

  it('keeps plain-text fallback when it is not protocol', () => {
    expect(proseForClean('', 'plain CLI output, no protocol')).toBe(
      'plain CLI output, no protocol',
    );
  });

  it('treats whitespace-only prose as empty', () => {
    expect(proseForClean('   \n  ', CLAUDE_INIT_NDJSON)).toBe('');
  });
});
