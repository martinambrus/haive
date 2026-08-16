import { describe, it, expect } from 'vitest';
import {
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
