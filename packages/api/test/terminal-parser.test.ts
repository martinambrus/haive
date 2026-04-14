import { describe, expect, it } from 'vitest';
import { scanOauthPrompts, stripControlBytes } from '../src/routes/terminal.js';

describe('stripControlBytes', () => {
  it('removes 0x03 and 0x04 bytes', () => {
    const input = `hello\u0003world\u0004!`;
    expect(stripControlBytes(input)).toBe('helloworld!');
  });

  it('preserves normal input', () => {
    expect(stripControlBytes('ls -la\n')).toBe('ls -la\n');
  });

  it('handles empty string', () => {
    expect(stripControlBytes('')).toBe('');
  });

  it('drops frame consisting only of control bytes', () => {
    expect(stripControlBytes('\u0003\u0003\u0004')).toBe('');
  });
});

describe('scanOauthPrompts', () => {
  it('emits an oauth_prompt frame for a Claude verification URL', () => {
    const seen = new Set<string>();
    const out = scanOauthPrompts(
      'Please visit https://claude.ai/oauth/authorize?code=abc to continue.',
      '',
      seen,
    );
    expect(out.newFrames).toHaveLength(1);
    const frame = out.newFrames[0]!;
    expect(frame.type).toBe('oauth_prompt');
    if (frame.type === 'oauth_prompt') {
      expect(frame.url).toBe('https://claude.ai/oauth/authorize?code=abc');
      expect(frame.service).toBe('claude');
    }
  });

  it('ignores URLs that do not match oauth hints', () => {
    const seen = new Set<string>();
    const out = scanOauthPrompts('fetched https://github.com/user/repo ok', '', seen);
    expect(out.newFrames).toHaveLength(0);
  });

  it('dedupes identical URLs across chunks', () => {
    const seen = new Set<string>();
    const first = scanOauthPrompts('visit https://auth.openai.com/device/code?x=1', '', seen);
    expect(first.newFrames).toHaveLength(1);
    const second = scanOauthPrompts(
      'visit https://auth.openai.com/device/code?x=1 (retry)',
      first.nextBuffer,
      seen,
    );
    expect(second.newFrames).toHaveLength(0);
  });

  it('strips ANSI escape sequences before matching', () => {
    const seen = new Set<string>();
    const colored = '\u001b[32mhttps://accounts.google.com/oauth/authorize?q=1\u001b[0m';
    const out = scanOauthPrompts(colored, '', seen);
    expect(out.newFrames).toHaveLength(1);
    const frame = out.newFrames[0]!;
    expect(frame.type).toBe('oauth_prompt');
    if (frame.type === 'oauth_prompt') {
      expect(frame.url).toBe('https://accounts.google.com/oauth/authorize?q=1');
      expect(frame.service).toBe('gemini');
    }
  });

  it('trims trailing punctuation from URL', () => {
    const seen = new Set<string>();
    const out = scanOauthPrompts('Go to (https://claude.ai/oauth/authorize?x=1).', '', seen);
    expect(out.newFrames).toHaveLength(1);
    if (out.newFrames[0]!.type === 'oauth_prompt') {
      expect(out.newFrames[0]!.url).toBe('https://claude.ai/oauth/authorize?x=1');
    }
  });

  it('caps the rolling buffer size', () => {
    const seen = new Set<string>();
    const filler = 'x'.repeat(32_000);
    const out = scanOauthPrompts(filler, '', seen);
    expect(out.nextBuffer.length).toBeLessThanOrEqual(16_384);
    expect(out.newFrames).toHaveLength(0);
  });
});
