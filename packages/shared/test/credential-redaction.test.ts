import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_WITHHELD,
  redactCredentialText,
  scanTextForCredentials,
} from '../src/credential-scan.js';
import { redactCommitDiffJson } from '../src/commit-diff-artifact.js';

describe('committed-secret rules at evidence sinks', () => {
  it('uses every scanner nomination and preserves other lines and their endings', () => {
    const secret = randomBytes(24).toString('hex');
    const lines = [
      'ordinary text',
      `TOKEN="${secret}"`,
      `password: ${secret}`,
      `const key = "ghp_${randomBytes(18).toString('hex')}";`,
      `postgres://account:${secret}@host/db`,
      'no changes here',
    ];
    const text = lines.join('\r\n');
    const hits = new Set(scanTextForCredentials('fixture', text).map((h) => h.line));
    expect(hits.size).toBe(4);
    const safe = redactCredentialText(text);
    expect(safe).toBe(
      lines.map((s, i) => (hits.has(i + 1) ? CREDENTIAL_WITHHELD : s)).join('\r\n'),
    );
    expect(redactCredentialText(safe)).toBe(safe);
  });
  it('withholds the private key body as well as its nominated marker', () => {
    const body = randomBytes(64).toString('base64');
    const text = `before\n-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\nafter\n`;
    expect(redactCredentialText(text)).toBe(
      `before\n${CREDENTIAL_WITHHELD}\n${CREDENTIAL_WITHHELD}\n${CREDENTIAL_WITHHELD}\nafter\n`,
    );
    expect(redactCredentialText(`before\n-----BEGIN PRIVATE KEY-----\n${body}`)).toBe(
      `before\n${CREDENTIAL_WITHHELD}\n${CREDENTIAL_WITHHELD}`,
    );
  });
  it('keeps non-secret content byte for byte, including placeholders and mixed endings', () => {
    const text = 'token = process.env.TOKEN;\r\nconst a = 1;\npassword="placeholder"\r\n';
    expect(redactCredentialText(text)).toBe(text);
  });
  it('refuses malformed artifacts instead of scanning escaped partial JSON', () => {
    expect(redactCommitDiffJson('{"files":[')).toBe(CREDENTIAL_WITHHELD);
    expect(redactCommitDiffJson('{"files":[{}]}')).toBe(CREDENTIAL_WITHHELD);
  });
});
