import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signRagToken, verifyRagToken } from '../src/rag/token.js';
import {
  DEFAULT_TASK_TOKEN_TTL_SECONDS,
  TASK_TOKEN_AUDIENCES,
  signTaskToken,
  verifyTaskToken,
  type TaskTokenAudience,
} from '../src/task-token.js';

const SECRET = 'task-token-test-secret-0123456789';
const AUDIENCES = [...TASK_TOKEN_AUDIENCES];
const FOUR_AUDIENCES = ['rag', 'ddev', 'custom-mcp', 'integrations'] as const;

const otherAudience = (aud: TaskTokenAudience): TaskTokenAudience =>
  aud === 'rag' ? 'ddev' : 'rag';

const b64 = (value: unknown): string =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

/** A token built from the documented format alone, so a payload the signer would never emit can be tested. */
function handSigned(macAud: string, payload: string, secret = SECRET): string {
  const key = createHmac('sha256', secret).update(`haive-task-token:${macAud}`).digest();
  const mac = createHmac('sha256', key).update(`v1.${payload}`).digest('base64url');
  return `v1.${payload}.${mac}`;
}

const NOW_SECONDS = 1_800_000_000;

afterEach(() => {
  vi.useRealTimers();
});

describe('task token audiences', () => {
  it('are a closed list', () => {
    expect([...TASK_TOKEN_AUDIENCES]).toEqual(['rag', 'ddev', 'custom-mcp', 'integrations']);
  });

  it('verify each of the four only under its own audience', () => {
    for (const minted of FOUR_AUDIENCES) {
      const token = signTaskToken(
        { aud: minted, taskId: 'task-abc', taskStepId: 'step-1', cliInvocationId: 'inv-1' },
        SECRET,
      );
      for (const checked of FOUR_AUDIENCES) {
        expect(verifyTaskToken(token, checked, SECRET) !== null, `${minted} under ${checked}`).toBe(
          minted === checked,
        );
      }
    }
  });

  it('give an integrations token the task, step and invocation it was signed for', () => {
    const token = signTaskToken(
      { aud: 'integrations', taskId: 'task-abc', taskStepId: 'step-1', cliInvocationId: 'inv-1' },
      SECRET,
    );

    expect(verifyTaskToken(token, 'integrations', SECRET)).toEqual({
      aud: 'integrations',
      taskId: 'task-abc',
      taskStepId: 'step-1',
      cliInvocationId: 'inv-1',
      exp: expect.any(Number),
    });
  });

  it('keep every token to its own audience', () => {
    for (const minted of AUDIENCES) {
      const token = signTaskToken({ aud: minted, taskId: 'task-abc' }, SECRET);
      for (const checked of AUDIENCES) {
        expect(verifyTaskToken(token, checked, SECRET) !== null, `${minted} under ${checked}`).toBe(
          minted === checked,
        );
      }
    }
  });

  it('refuse to sign for an audience outside the list', () => {
    expect(() => signTaskToken({ aud: 'nope' as never, taskId: 'task-abc' }, SECRET)).toThrow();
  });

  it('verify nothing for an audience outside the list', () => {
    const token = signTaskToken({ aud: 'rag', taskId: 'task-abc' }, SECRET);
    expect(verifyTaskToken(token, 'nope' as never, SECRET)).toBeNull();
  });
});

describe.each(AUDIENCES)('task token for %s', (aud) => {
  it('round-trips and recovers every claim', () => {
    const token = signTaskToken(
      { aud, taskId: 'task-abc', taskStepId: 'step-1', cliInvocationId: 'inv-1' },
      SECRET,
    );

    expect(verifyTaskToken(token, aud, SECRET)).toEqual({
      aud,
      taskId: 'task-abc',
      taskStepId: 'step-1',
      cliInvocationId: 'inv-1',
      exp: expect.any(Number),
    });
  });

  it('carries no optional claim that was not given', () => {
    const token = signTaskToken({ aud, taskId: 'task-abc' }, SECRET);

    expect(Object.keys(verifyTaskToken(token, aud, SECRET) ?? {}).sort()).toEqual([
      'aud',
      'exp',
      'taskId',
    ]);
  });

  it('has the form v1.<payload>.<mac>, all base64url', () => {
    const parts = signTaskToken({ aud, taskId: 'task-abc' }, SECRET).split('.');

    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('v1');
    expect(parts[1]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parts[2]).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('is accepted when built by hand from the documented format', () => {
    const payload = b64({ aud, taskId: 'task-abc', exp: Math.floor(Date.now() / 1000) + 60 });

    expect(verifyTaskToken(handSigned(aud, payload), aud, SECRET)).toMatchObject({
      aud,
      taskId: 'task-abc',
    });
  });

  it('is refused under the other audience', () => {
    const token = signTaskToken({ aud, taskId: 'task-abc' }, SECRET);

    expect(verifyTaskToken(token, aud, SECRET)).not.toBeNull();
    expect(verifyTaskToken(token, otherAudience(aud), SECRET)).toBeNull();
  });

  it('is refused when its payload is rewritten to name the other audience', () => {
    const [version, payload, mac] = signTaskToken({ aud, taskId: 'task-abc' }, SECRET).split('.');
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as object;
    const forged = b64({ ...decoded, aud: otherAudience(aud) });

    expect(verifyTaskToken(`${version}.${forged}.${mac}`, otherAudience(aud), SECRET)).toBeNull();
    expect(verifyTaskToken(`${version}.${forged}.${mac}`, aud, SECRET)).toBeNull();
  });

  it('is refused when it is signed for this audience but its payload names the other', () => {
    const other = otherAudience(aud);
    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = handSigned(aud, b64({ aud: other, taskId: 'task-abc', exp }));

    expect(verifyTaskToken(token, other, SECRET)).toBeNull();
    expect(verifyTaskToken(token, aud, SECRET)).toBeNull();
  });

  it('is refused under a different secret', () => {
    const token = signTaskToken({ aud, taskId: 'task-abc' }, SECRET);

    expect(verifyTaskToken(token, aud, 'other-secret')).toBeNull();
  });

  it('is refused with a tampered payload', () => {
    const [version, payload, mac] = signTaskToken({ aud, taskId: 'task-abc' }, SECRET).split('.');
    const forged = b64({ aud, taskId: 'evil', exp: 99_999_999_999 });

    expect(verifyTaskToken(`${version}.${forged}.${mac}`, aud, SECRET)).toBeNull();
    expect(verifyTaskToken(`${version}.${payload}.${mac}`, aud, SECRET)).toMatchObject({
      taskId: 'task-abc',
    });
  });

  it('is refused with a tampered MAC', () => {
    const [version, payload, mac] = signTaskToken({ aud, taskId: 'task-abc' }, SECRET).split('.');
    const flipped = `${mac!.slice(0, -1)}${mac!.endsWith('A') ? 'B' : 'A'}`;

    expect(verifyTaskToken(`${version}.${payload}.${flipped}`, aud, SECRET)).toBeNull();
    expect(verifyTaskToken(`${version}.${payload}.${mac!.slice(0, -1)}`, aud, SECRET)).toBeNull();
  });

  it('expires, by the second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SECONDS * 1000);
    const token = signTaskToken({ aud, taskId: 'task-abc', ttlSeconds: 10 }, SECRET);

    vi.setSystemTime((NOW_SECONDS + 10) * 1000);
    expect(verifyTaskToken(token, aud, SECRET)).not.toBeNull();
    vi.setSystemTime((NOW_SECONDS + 11) * 1000);
    expect(verifyTaskToken(token, aud, SECRET)).toBeNull();
  });

  it('is refused when already expired at signing', () => {
    expect(
      verifyTaskToken(signTaskToken({ aud, taskId: 't', ttlSeconds: -1 }, SECRET), aud, SECRET),
    ).toBeNull();
  });

  it('lives 24 hours unless told otherwise', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SECONDS * 1000);

    const token = signTaskToken({ aud, taskId: 'task-abc' }, SECRET);

    expect(DEFAULT_TASK_TOKEN_TTL_SECONDS).toBe(86_400);
    expect(verifyTaskToken(token, aud, SECRET)?.exp).toBe(NOW_SECONDS + 86_400);
  });

  it('is refused in every malformed shape', () => {
    const token = signTaskToken({ aud, taskId: 'task-abc' }, SECRET);
    const [, payload, mac] = token.split('.') as [string, string, string];
    const shapes: Record<string, string> = {
      empty: '',
      'one part': 'not-a-token',
      'two parts, the version dropped': `${payload}.${mac}`,
      'two parts, the legacy format': signRagToken('task-abc', SECRET),
      'four parts': `${token}.extra`,
      'a trailing dot': `${token}.`,
      'a leading dot': `.${token}`,
      'an empty payload': `v1..${mac}`,
      'an empty MAC': `v1.${payload}.`,
      'another version': `v2.${payload}.${mac}`,
      'an upper-case version': `V1.${payload}.${mac}`,
      'a padded payload': `v1.${payload}=.${mac}`,
      'a payload with a space': `v1.${payload} .${mac}`,
      'a MAC with a plus': `v1.${payload}.${mac.slice(0, -1)}+`,
      'a token with leading whitespace': ` ${token}`,
      'a token with trailing whitespace': `${token} `,
    };

    for (const [name, candidate] of Object.entries(shapes)) {
      expect(verifyTaskToken(candidate, aud, SECRET), name).toBeNull();
    }
  });

  it('is refused when a correctly signed payload is not a claims object', () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const payloads: Record<string, string> = {
      'not JSON': b64('not json'),
      'a JSON null': b64('null'),
      'a JSON number': b64('5'),
      'a JSON string': b64('"x"'),
      'a JSON array': b64('[]'),
      'no taskId': b64({ aud, exp }),
      'a numeric taskId': b64({ aud, taskId: 5, exp }),
      'an empty taskId': b64({ aud, taskId: '', exp }),
      'no exp': b64({ aud, taskId: 'task-abc' }),
      'a string exp': b64({ aud, taskId: 'task-abc', exp: String(exp) }),
      'no aud': b64({ taskId: 'task-abc', exp }),
      'a numeric taskStepId': b64({ aud, taskId: 'task-abc', taskStepId: 1, exp }),
      'a numeric cliInvocationId': b64({ aud, taskId: 'task-abc', cliInvocationId: 1, exp }),
    };

    for (const [name, payload] of Object.entries(payloads)) {
      expect(verifyTaskToken(handSigned(aud, payload), aud, SECRET), name).toBeNull();
    }
  });
});

describe('the two token formats', () => {
  it('never verify each other', () => {
    const legacy = signRagToken('task-abc', SECRET);
    const scoped = signTaskToken({ aud: 'rag', taskId: 'task-abc' }, SECRET);

    expect(verifyRagToken(scoped, SECRET)).toBeNull();
    expect(verifyRagToken(legacy, SECRET)).toEqual({ taskId: 'task-abc' });
    for (const aud of AUDIENCES) expect(verifyTaskToken(legacy, aud, SECRET)).toBeNull();
  });

  it('keep a legacy token out even when its payload claims an audience', () => {
    const payload = b64({
      aud: 'ddev',
      taskId: 'task-abc',
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const mac = createHmac('sha256', SECRET).update(payload).digest('base64url');

    expect(verifyRagToken(`${payload}.${mac}`, SECRET)).toEqual({ taskId: 'task-abc' });
    expect(verifyTaskToken(`${payload}.${mac}`, 'ddev', SECRET)).toBeNull();
  });
});
