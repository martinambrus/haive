import { describe, expect, it } from 'vitest';
import { signRagToken, verifyRagToken } from '../src/rag/token.js';

const SECRET = 'test-secret-key-0123456789';

describe('rag task token', () => {
  it('round-trips a valid token and recovers the taskId', () => {
    const token = signRagToken('task-abc', SECRET);
    const out = verifyRagToken(token, SECRET);
    expect(out).toEqual({ taskId: 'task-abc' });
  });

  it('rejects a token signed with a different secret', () => {
    const token = signRagToken('task-abc', SECRET);
    expect(verifyRagToken(token, 'other-secret')).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const token = signRagToken('task-abc', SECRET);
    const [payload, mac] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ taskId: 'evil', exp: 99999999999 })).toString(
      'base64url',
    );
    expect(verifyRagToken(`${forged}.${mac}`, SECRET)).toBeNull();
    // original still valid as a control
    expect(verifyRagToken(`${payload}.${mac}`, SECRET)).toEqual({ taskId: 'task-abc' });
  });

  it('rejects an expired token', () => {
    const token = signRagToken('task-abc', SECRET, -1);
    expect(verifyRagToken(token, SECRET)).toBeNull();
  });

  it('rejects malformed tokens', () => {
    expect(verifyRagToken('', SECRET)).toBeNull();
    expect(verifyRagToken('not-a-token', SECRET)).toBeNull();
    expect(verifyRagToken('a.b.c', SECRET)).toBeNull();
  });
});
