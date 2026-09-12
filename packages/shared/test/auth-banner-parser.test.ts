import { describe, it, expect } from 'vitest';
import {
  AMP_PASTE_LOGIN_URL_PREFIX,
  AUTH_URL_PREFIXES,
  TOKEN_PASTE_PROVIDERS,
  detectAuthResult,
  extractDeviceCode,
  extractGeminiAuthUrl,
  extractWrappedUrl,
} from '../src/cli-providers/auth-banner-parser.js';

describe('AUTH_URL_PREFIXES', () => {
  it('includes gemini', () => {
    expect(AUTH_URL_PREFIXES.gemini?.[0]).toBe('https://accounts.google.com/o/oauth2/');
  });
});

describe('extractGeminiAuthUrl', () => {
  it('returns null when preamble missing', () => {
    expect(extractGeminiAuthUrl('some unrelated output\n')).toBeNull();
  });

  it('extracts url after the preamble', () => {
    const raw =
      'Some banner text\n' +
      'Please visit the following URL to authorize the application: \n' +
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=abc&scope=openid\n' +
      '\n' +
      'unrelated trailing line\n';
    expect(extractGeminiAuthUrl(raw)).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=abc&scope=openid',
    );
  });

  it('handles TTY-wrapped URL spanning multiple lines', () => {
    const raw =
      'Please visit the following URL to authorize the application:\n' +
      'https://accounts.google.com/o/oauth2/\n' +
      'v2/auth?client_id=xxx&state=wrapped_state\n' +
      '\n';
    expect(extractGeminiAuthUrl(raw)).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=xxx&state=wrapped_state',
    );
  });

  it('strips ANSI before matching', () => {
    const raw =
      '\x1b[32mPlease visit the following URL to authorize the application:\x1b[0m\n' +
      '\x1b[34mhttps://accounts.google.com/o/oauth2/v2/auth?state=zzz\x1b[0m\n\n';
    expect(extractGeminiAuthUrl(raw)).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth?state=zzz',
    );
  });

  it('is case-insensitive on the preamble', () => {
    const raw =
      'PLEASE VISIT THE FOLLOWING URL TO AUTHORIZE the flow:\n' +
      'https://accounts.google.com/o/oauth2/v2/auth?state=yy\n\n';
    expect(extractGeminiAuthUrl(raw)).toBe('https://accounts.google.com/o/oauth2/v2/auth?state=yy');
  });
});

describe('TOKEN_PASTE_PROVIDERS', () => {
  it('includes gemini alongside claude-code', () => {
    expect(TOKEN_PASTE_PROVIDERS.has('gemini')).toBe(true);
    expect(TOKEN_PASTE_PROVIDERS.has('claude-code')).toBe(true);
    expect(TOKEN_PASTE_PROVIDERS.has('codex')).toBe(false);
  });

  it('excludes grok — its device-code flow pastes nothing back', () => {
    // Membership here gates `canDetect`: a paste provider is only inspected for
    // success AFTER a token is submitted. grok never submits one, so listing it
    // would stall the modal forever on a login that had already succeeded.
    expect(TOKEN_PASTE_PROVIDERS.has('grok')).toBe(false);
  });

  it('excludes amp — it became a device-code flow in 0.0.1789200043', () => {
    expect(TOKEN_PASTE_PROVIDERS.has('amp')).toBe(false);
  });
});

// VERBATIM output of a real `amp login` (amp 0.0.1789200043-gdb3b35), ANSI and
// CRLF included, because that is what reaches the parser off the container's
// PTY — the URL arrives wrapped in colour codes and the extractor has to strip
// them. Kept exact rather than paraphrased: the host is auth.ampcode.com, NOT
// the ampcode.com/auth/cli-login page the paste-back flow used.
const AMP_DEVICE_BANNER =
  'To log in, visit:\r\n' +
  '\r\n' +
  '\x1b[34m\x1b[1mhttps://auth.ampcode.com/device?user_code=WMSD-BBRS\x1b[22m\x1b[39m\r\n' +
  '\r\n' +
  'and confirm that the code shown matches: \x1b[1mWMSD-BBRS\x1b[22m\r\n' +
  '\r\n' +
  'Waiting for confirmation in the browser...\r\n';

// Output of `amp login` on 0.0.1786896116-gd65cd9 (2026-08-16), the paste-back
// shape a provider pinned to an older CLI version still gets. Kept beside the
// device banner because both are live: the version is a user pin. Verbatim
// apart from the authToken, which is a real login nonce and is replaced here by
// a synthetic string of the same shape — the parser keys on the URL PREFIX, so
// only the token's length and alphabet matter to this fixture.
const AMP_PASTE_TOKEN = 'a'.repeat(64);
const AMP_PASTE_BANNER =
  'If your browser does not open automatically, visit:\r\n' +
  '\r\n' +
  `\x1b[34m\x1b[1m${AMP_PASTE_LOGIN_URL_PREFIX}?authToken=${AMP_PASTE_TOKEN}\x1b[22m\x1b[39m\r\n` +
  '\r\n';

describe('amp device-code login parsing', () => {
  it('declares the measured auth.ampcode.com device prefix first', () => {
    expect(AUTH_URL_PREFIXES.amp?.[0]).toBe('https://auth.ampcode.com/device');
  });

  it('keeps the paste-back prefix so an older amp still signs in', () => {
    expect(AUTH_URL_PREFIXES.amp).toContain('https://ampcode.com/auth/cli-login');
  });

  it('extracts the authorization URL from the real banner', () => {
    const url = extractWrappedUrl(AMP_DEVICE_BANNER, AUTH_URL_PREFIXES.amp ?? []);
    expect(url).toBe('https://auth.ampcode.com/device?user_code=WMSD-BBRS');
  });

  it('still extracts the URL an older pinned amp prints', () => {
    expect(extractWrappedUrl(AMP_PASTE_BANNER, AUTH_URL_PREFIXES.amp ?? [])).toBe(
      `${AMP_PASTE_LOGIN_URL_PREFIX}?authToken=${AMP_PASTE_TOKEN}`,
    );
  });

  it('separates the two flows by the URL, which is what the session keys on', () => {
    // The CLI version is a provider pin, so both shapes stay reachable and the
    // URL is the only per-session evidence of which one is running.
    const paste = extractWrappedUrl(AMP_PASTE_BANNER, AUTH_URL_PREFIXES.amp ?? []) ?? '';
    const device = extractWrappedUrl(AMP_DEVICE_BANNER, AUTH_URL_PREFIXES.amp ?? []) ?? '';
    expect(paste.startsWith(AMP_PASTE_LOGIN_URL_PREFIX)).toBe(true);
    expect(device.startsWith(AMP_PASTE_LOGIN_URL_PREFIX)).toBe(false);
  });

  it('extracts the short user code with the shared pattern', () => {
    expect(extractDeviceCode(AMP_DEVICE_BANNER)).toBe('WMSD-BBRS');
  });

  it('does not report success while still waiting for approval', () => {
    // The banner sits in the buffer for the whole approval wait, and amp is no
    // longer gated behind a token submit, so a false positive here would flip
    // the modal to success before the user had approved anything.
    expect(detectAuthResult(AMP_DEVICE_BANNER)).toBeNull();
  });
});

// VERBATIM output of a real `grok login --device-auth` (grok 1.0.3). Kept exact
// so the parsers are tested against what the CLI actually prints rather than a
// paraphrase — the URL host in particular is accounts.x.ai, NOT the auth.x.ai
// that xAI's docs describe.
const GROK_DEVICE_BANNER =
  '\nTo sign in, open this URL in your browser:\n\n' +
  '  https://accounts.x.ai/oauth2/device?user_code=PZVK-REH7\n\n' +
  'Confirm this code in your browser:\n\n' +
  '  PZVK-REH7\n\n' +
  "Only continue with a code you requested. Don't share it with anyone.\n\n" +
  'Waiting for authorization...\n';

describe('grok device-code login parsing', () => {
  it('declares the measured accounts.x.ai device prefix', () => {
    expect(AUTH_URL_PREFIXES.grok?.[0]).toBe('https://accounts.x.ai/oauth2/device');
  });

  it('extracts the authorization URL from the real banner', () => {
    const url = extractWrappedUrl(GROK_DEVICE_BANNER, AUTH_URL_PREFIXES.grok ?? []);
    expect(url).toBe('https://accounts.x.ai/oauth2/device?user_code=PZVK-REH7');
  });

  it('extracts the short user code with the shared pattern', () => {
    expect(extractDeviceCode(GROK_DEVICE_BANNER)).toBe('PZVK-REH7');
  });

  it('does not report success while still waiting for approval', () => {
    // The banner is in the buffer for the whole approval wait. If any of its
    // wording tripped detectAuthResult the modal would claim success before the
    // user had signed in, and the probe would then fail against absent creds.
    expect(detectAuthResult(GROK_DEVICE_BANNER)).toBeNull();
  });

  it('reports success on the line grok actually prints', () => {
    // `Signed in as <user>` — confirmed as a literal in the shipped binary. It
    // matches detectAuthResult's existing `signed in` clause, so grok needs no
    // new success pattern.
    expect(detectAuthResult('Signed in as someone@example.com\n')).toEqual({ kind: 'success' });
  });
});
