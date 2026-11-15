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
    const label = ['PRIVATE', 'KEY'].join(' ');
    const begin = ['-----BEGIN', label + '-----'].join(' ');
    const end = ['-----END', label + '-----'].join(' ');
    const text = `before\n${begin}\n${body}\n${end}\nafter\n`;
    expect(redactCredentialText(text)).toBe(
      `before\n${CREDENTIAL_WITHHELD}\n${CREDENTIAL_WITHHELD}\n${CREDENTIAL_WITHHELD}\nafter\n`,
    );
    expect(redactCredentialText(`before\n${begin}\n${body}`)).toBe(
      `before\n${CREDENTIAL_WITHHELD}\n${CREDENTIAL_WITHHELD}`,
    );
  });
  it('withholds NUL content entirely even when discovery skips it', () => {
    const text = `before\0\nTOKEN="${randomBytes(24).toString('hex')}"\nafter`;
    expect(scanTextForCredentials('fixture', text)).toEqual([]);
    expect(redactCredentialText(text)).toBe(CREDENTIAL_WITHHELD);
  });
  it('keeps non-secret content byte for byte, including placeholders and mixed endings', () => {
    const text = 'token = process.env.TOKEN;\r\nconst a = 1;\npassword="placeholder"\r\n';
    expect(redactCredentialText(text)).toBe(text);
  });
  it.each([
    '{"files":[',
    '{"files":[{}]}',
    '{"files":[]}',
    '{"headSha":null,"fileCount":1,"truncated":false,"files":[{"oldContent":"","newContent":""}]}',
  ])('returns a renderable withheld artifact for malformed or partial JSON: %s', (text) => {
    const safe = JSON.parse(redactCommitDiffJson(text));
    expect(safe).toMatchObject({
      headSha: null,
      fileCount: 1,
      truncated: false,
      files: [
        {
          path: 'withheld',
          status: 'modified',
          binary: false,
          truncated: false,
          unreadable: true,
          unreadableReason: CREDENTIAL_WITHHELD,
          oldContent: '',
          newContent: '',
        },
      ],
    });
  });
});
