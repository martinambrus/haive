import { describe, it, expect } from 'vitest';
import {
  AUTH_URL_PREFIXES,
  TOKEN_PASTE_PROVIDERS,
  extractGeminiAuthUrl,
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
});
