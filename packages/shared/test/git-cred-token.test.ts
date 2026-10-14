import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GIT_CRED_TOKEN_TTL_SECONDS,
  signRepoGitCredToken,
  verifyLegacyRepoGitCredToken,
  verifyRepoGitCredToken,
} from '../src/git/token.js';
import { signRagToken, verifyRagToken } from '../src/rag/token.js';
import { TASK_TOKEN_AUDIENCES, signTaskToken, verifyTaskToken } from '../src/task-token.js';

const SECRET = 'test-secret-key-0123456789';
const CLAIMS = { repositoryId: 'repo-abc', userId: 'user-1' };
const AUDIENCES = [...TASK_TOKEN_AUDIENCES];
const NOW_SECONDS = 1_800_000_000;

const b64 = (value: unknown): string =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

const inAMinute = (): number => Math.floor(Date.now() / 1000) + 60;

const gitKey = (secret: string): Buffer =>
  createHmac('sha256', secret).update('git-credential-token:v1').digest();

/** A v1 token built from the documented format alone, so a MAC key or payload the signer would never use can be tested. */
function handSigned(payload: string, key: Buffer | string = gitKey(SECRET)): string {
  return `v1.${payload}.${createHmac('sha256', key).update(`v1.${payload}`).digest('base64url')}`;
}

/** The two-part form from before v1, `<payload>.<hmac(raw secret, payload)>`, which the signer no longer emits. */
function legacyToken(claims: unknown, secret = SECRET): string {
  const payload = b64(claims);
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('repo git credential token', () => {
  it('round-trips a valid token and recovers repositoryId + userId', () => {
    const token = signRepoGitCredToken('repo-abc', 'user-1', SECRET);

    expect(verifyRepoGitCredToken(token, SECRET)).toEqual(CLAIMS);
  });

  it('has the form v1.<payload>.<mac>, all base64url', () => {
    const parts = signRepoGitCredToken('repo-abc', 'user-1', SECRET).split('.');

    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('v1');
    expect(parts[1]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parts[2]).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('is accepted when built by hand from the documented format', () => {
    const token = handSigned(b64({ ...CLAIMS, exp: inAMinute() }));

    expect(verifyRepoGitCredToken(token, SECRET)).toEqual(CLAIMS);
  });

  it('is refused under a different secret', () => {
    const token = signRepoGitCredToken('repo-abc', 'user-1', SECRET);

    expect(verifyRepoGitCredToken(token, 'other-secret')).toBeNull();
  });

  it('is refused when its MAC is keyed with the raw secret', () => {
    const payload = b64({ ...CLAIMS, exp: inAMinute() });
    const macOfPayloadAlone = createHmac('sha256', SECRET).update(payload).digest('base64url');

    expect(verifyRepoGitCredToken(handSigned(payload), SECRET)).toEqual(CLAIMS);
    expect(verifyRepoGitCredToken(handSigned(payload, SECRET), SECRET)).toBeNull();
    expect(verifyRepoGitCredToken(`v1.${payload}.${macOfPayloadAlone}`, SECRET)).toBeNull();
  });

  it('is refused with a tampered payload (different repo/user) under the original MAC', () => {
    const [version, payload, mac] = signRepoGitCredToken('repo-abc', 'user-1', SECRET).split('.');
    const forged = b64({ repositoryId: 'evil', userId: 'attacker', exp: 99_999_999_999 });

    expect(verifyRepoGitCredToken(`${version}.${forged}.${mac}`, SECRET)).toBeNull();
    expect(verifyRepoGitCredToken(`${version}.${payload}.${mac}`, SECRET)).toEqual(CLAIMS);
  });

  it('is refused with a tampered MAC', () => {
    const [version, payload, mac] = signRepoGitCredToken('repo-abc', 'user-1', SECRET).split('.');
    const flipped = `${mac!.slice(0, -1)}${mac!.endsWith('A') ? 'B' : 'A'}`;

    expect(verifyRepoGitCredToken(`${version}.${payload}.${flipped}`, SECRET)).toBeNull();
    expect(verifyRepoGitCredToken(`${version}.${payload}.${mac!.slice(0, -1)}`, SECRET)).toBeNull();
  });

  it('is refused when already expired at signing', () => {
    const token = signRepoGitCredToken('repo-abc', 'user-1', SECRET, -1);

    expect(verifyRepoGitCredToken(token, SECRET)).toBeNull();
  });

  it('expires, by the second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SECONDS * 1000);
    const token = signRepoGitCredToken('repo-abc', 'user-1', SECRET, 10);

    vi.setSystemTime((NOW_SECONDS + 10) * 1000);
    expect(verifyRepoGitCredToken(token, SECRET)).not.toBeNull();
    vi.setSystemTime((NOW_SECONDS + 11) * 1000);
    expect(verifyRepoGitCredToken(token, SECRET)).toBeNull();
  });

  it('lives 12 hours unless told otherwise', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SECONDS * 1000);
    const token = signRepoGitCredToken('repo-abc', 'user-1', SECRET);

    expect(DEFAULT_GIT_CRED_TOKEN_TTL_SECONDS).toBe(43_200);
    vi.setSystemTime((NOW_SECONDS + 43_200) * 1000);
    expect(verifyRepoGitCredToken(token, SECRET)).not.toBeNull();
    vi.setSystemTime((NOW_SECONDS + 43_201) * 1000);
    expect(verifyRepoGitCredToken(token, SECRET)).toBeNull();
  });

  it('is refused in every malformed shape', () => {
    const token = signRepoGitCredToken('repo-abc', 'user-1', SECRET);
    const [, payload, mac] = token.split('.') as [string, string, string];
    const shapes: Record<string, string> = {
      empty: '',
      'one part': 'not-a-token',
      'three parts, no version': 'a.b.c',
      'two parts, the version dropped': `${payload}.${mac}`,
      'two parts, the legacy format': legacyToken({ ...CLAIMS, exp: inAMinute() }),
      'four parts': `${token}.extra`,
      'a trailing dot': `${token}.`,
      'a leading dot': `.${token}`,
      'an empty payload': `v1..${mac}`,
      'an empty MAC': `v1.${payload}.`,
      'another version': `v2.${payload}.${mac}`,
      'an upper-case version': `V1.${payload}.${mac}`,
      'a padded payload': `v1.${payload}=.${mac}`,
      'a correctly signed padded payload': handSigned(`${payload}=`),
      'a payload with a space': `v1.${payload} .${mac}`,
      'a MAC with a plus': `v1.${payload}.${mac.slice(0, -1)}+`,
      'a token with leading whitespace': ` ${token}`,
      'a token with trailing whitespace': `${token} `,
    };

    for (const [name, candidate] of Object.entries(shapes)) {
      expect(verifyRepoGitCredToken(candidate, SECRET), name).toBeNull();
    }
  });

  it('is refused when a correctly signed payload is not a claims object', () => {
    const exp = inAMinute();
    const payloads: Record<string, string> = {
      'not JSON': b64('not json'),
      'a JSON null': b64('null'),
      'a JSON number': b64('5'),
      'a JSON string': b64('"x"'),
      'a JSON array': b64('[]'),
      'no repositoryId': b64({ userId: 'user-1', exp }),
      'a numeric repositoryId': b64({ repositoryId: 5, userId: 'user-1', exp }),
      'an empty repositoryId': b64({ repositoryId: '', userId: 'user-1', exp }),
      'no userId': b64({ repositoryId: 'repo-abc', exp }),
      'a numeric userId': b64({ repositoryId: 'repo-abc', userId: 5, exp }),
      'an empty userId': b64({ repositoryId: 'repo-abc', userId: '', exp }),
      'no exp': b64(CLAIMS),
      'a string exp': b64({ ...CLAIMS, exp: String(exp) }),
    };

    for (const [name, payload] of Object.entries(payloads)) {
      expect(verifyRepoGitCredToken(handSigned(payload), SECRET), name).toBeNull();
    }
  });
});

describe('no other token verifies as a git credential token', () => {
  it.each(AUDIENCES)('a %s task token is refused, by either verifier', (aud) => {
    const token = signTaskToken({ aud, taskId: 'repo-abc' }, SECRET);

    expect(verifyTaskToken(token, aud, SECRET)).not.toBeNull();
    expect(verifyRepoGitCredToken(token, SECRET)).toBeNull();
    expect(verifyLegacyRepoGitCredToken(token, SECRET)).toBeNull();
  });

  it.each(AUDIENCES)('a %s task token is refused when its payload carries the claims', (aud) => {
    const payload = b64({ aud, taskId: 'task-abc', ...CLAIMS, exp: inAMinute() });
    const taskKey = createHmac('sha256', SECRET).update(`haive-task-token:${aud}`).digest();
    const token = handSigned(payload, taskKey);

    expect(verifyTaskToken(token, aud, SECRET)).not.toBeNull();
    expect(verifyRepoGitCredToken(token, SECRET)).toBeNull();
    expect(verifyLegacyRepoGitCredToken(token, SECRET)).toBeNull();
  });

  it('the legacy RAG token is refused, by either verifier', () => {
    const token = signRagToken('repo-abc', SECRET);

    expect(verifyRagToken(token, SECRET)).not.toBeNull();
    expect(verifyRepoGitCredToken(token, SECRET)).toBeNull();
    expect(verifyLegacyRepoGitCredToken(token, SECRET)).toBeNull();
  });
});

describe('a git credential token verifies nowhere else', () => {
  const v1 = () => signRepoGitCredToken('repo-abc', 'user-1', SECRET);
  const legacy = () => legacyToken({ ...CLAIMS, exp: inAMinute() });

  it.each(AUDIENCES)('under the %s task token audience', (aud) => {
    expect(verifyRepoGitCredToken(v1(), SECRET)).not.toBeNull();
    expect(verifyLegacyRepoGitCredToken(legacy(), SECRET)).not.toBeNull();
    expect(verifyTaskToken(v1(), aud, SECRET)).toBeNull();
    expect(verifyTaskToken(legacy(), aud, SECRET)).toBeNull();
  });

  it.each(AUDIENCES)('under the %s audience even when its payload names it', (aud) => {
    const token = handSigned(b64({ aud, taskId: 'task-abc', ...CLAIMS, exp: inAMinute() }));

    expect(verifyRepoGitCredToken(token, SECRET)).toEqual(CLAIMS);
    expect(verifyTaskToken(token, aud, SECRET)).toBeNull();
  });

  it('as a legacy RAG token', () => {
    expect(verifyRagToken(v1(), SECRET)).toBeNull();
    expect(verifyRagToken(legacy(), SECRET)).toBeNull();
  });
});

describe('the legacy two-part git credential token', () => {
  it('verifies through the fallback and recovers repositoryId + userId', () => {
    const token = legacyToken({ ...CLAIMS, exp: inAMinute() });

    expect(verifyLegacyRepoGitCredToken(token, SECRET)).toEqual(CLAIMS);
  });

  it('is refused by the v1 verifier, and a v1 token by the fallback', () => {
    const legacy = legacyToken({ ...CLAIMS, exp: inAMinute() });
    const v1 = signRepoGitCredToken('repo-abc', 'user-1', SECRET);

    expect(verifyRepoGitCredToken(legacy, SECRET)).toBeNull();
    expect(verifyLegacyRepoGitCredToken(v1, SECRET)).toBeNull();
  });

  it('is refused under a different secret', () => {
    const token = legacyToken({ ...CLAIMS, exp: inAMinute() });

    expect(verifyLegacyRepoGitCredToken(token, 'other-secret')).toBeNull();
  });

  it('is refused with a tampered payload (different repo/user) under the original MAC', () => {
    const [, mac] = legacyToken({ ...CLAIMS, exp: inAMinute() }).split('.');
    const forged = b64({ repositoryId: 'evil', userId: 'attacker', exp: 99_999_999_999 });

    expect(verifyLegacyRepoGitCredToken(`${forged}.${mac}`, SECRET)).toBeNull();
  });

  it('is refused once expired, by the second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SECONDS * 1000);
    const token = legacyToken({ ...CLAIMS, exp: NOW_SECONDS + 10 });

    vi.setSystemTime((NOW_SECONDS + 10) * 1000);
    expect(verifyLegacyRepoGitCredToken(token, SECRET)).not.toBeNull();
    vi.setSystemTime((NOW_SECONDS + 11) * 1000);
    expect(verifyLegacyRepoGitCredToken(token, SECRET)).toBeNull();
  });

  it('is refused in every malformed shape', () => {
    expect(verifyLegacyRepoGitCredToken('', SECRET)).toBeNull();
    expect(verifyLegacyRepoGitCredToken('not-a-token', SECRET)).toBeNull();
    expect(verifyLegacyRepoGitCredToken('a.b.c', SECRET)).toBeNull();
  });

  it('is refused when a correctly signed payload is not a claims object', () => {
    const exp = inAMinute();
    const payloads: Record<string, unknown> = {
      'not JSON': 'not json',
      'a JSON null': 'null',
      'no repositoryId': { userId: 'user-1', exp },
      'a numeric userId': { repositoryId: 'repo-abc', userId: 5, exp },
      'no exp': CLAIMS,
    };

    for (const [name, claims] of Object.entries(payloads)) {
      expect(verifyLegacyRepoGitCredToken(legacyToken(claims), SECRET), name).toBeNull();
    }
  });
});
