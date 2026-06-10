import { describe, it, expect } from 'vitest';
import { parseBizReqOutput } from './03b-business-requirements.js';

describe('parseBizReqOutput', () => {
  it('parses a fenced requirements doc', () => {
    const raw =
      'drafted\n```json\n{"requirements":"# Requirements\\n\\nUsers want X.","summary":"add X"}\n```';
    const p = parseBizReqOutput(raw);
    expect(p).not.toBeNull();
    expect(p!.requirements).toContain('Users want X.');
    expect(p!.summary).toBe('add X');
  });

  it('accepts an already-parsed object (bypass stub shape)', () => {
    const p = parseBizReqOutput({ requirements: '# R\n\nbody', summary: 's' });
    expect(p).not.toBeNull();
    expect(p!.summary).toBe('s');
  });

  it('returns null on empty requirements or garbled output', () => {
    expect(parseBizReqOutput('```json\n{"requirements":"","summary":"x"}\n```')).toBeNull();
    expect(parseBizReqOutput('no json')).toBeNull();
    expect(parseBizReqOutput(null)).toBeNull();
  });
});
