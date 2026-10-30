import { describe, it, expect } from 'vitest';
import {
  AMP_PASTE_LOGIN_URL_PREFIX,
  AUTH_URL_PREFIXES,
  TOKEN_PASTE_PROVIDERS,
  detectAuthResult,
  extractDeviceCode,
  extractWrappedUrl,
} from '../src/cli-providers/auth-banner-parser.js';

describe('TOKEN_PASTE_PROVIDERS', () => {
  it('holds the paste-back logins, claude-code and antigravity', () => {
    expect(TOKEN_PASTE_PROVIDERS.has('claude-code')).toBe(true);
    expect(TOKEN_PASTE_PROVIDERS.has('antigravity')).toBe(true);
    expect(TOKEN_PASTE_PROVIDERS.has('codex')).toBe(false);
    // gemini is API-key only: no in-app login exists for it.
    expect(TOKEN_PASTE_PROVIDERS.has('gemini')).toBe(false);
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

describe('auth result signal', () => {
  it('fix5 returns only the result kind without retaining credential-bearing stdout', () => {
    const secret = 'SyntheticCredential_Q7v9Z2p4R8x6';
    const signal = detectAuthResult(`authentication failed: ${secret}`);
    expect(signal?.kind === 'error').toBe(true);
    expect(Object.keys(signal ?? {}).every((key) => key === 'kind')).toBe(true);
    const serialized = JSON.stringify(signal);
    expect(
      Array.from({ length: secret.length - 5 }, (_, i) => secret.slice(i, i + 6)).some((part) =>
        serialized.includes(part),
      ),
    ).toBe(false);
  });
});

const CLAUDE_PREFIXES = AUTH_URL_PREFIXES['claude-code'] ?? [];
// Synthetic, ~200 characters, hard-wrapped at 80 columns the way the CLI's PTY prints it.
const CLAUDE_URL =
  'https://claude.ai/oauth/authorize?code=true&client_id=synthetic-client-id' +
  '&response_type=code&redirect_uri=https%3A%2F%2Fexample.invalid%2Fcb' +
  '&code_challenge=SyntheticChallenge0123456789&state=SyntheticState01';
const CLAUDE_LINES = Array.from({ length: Math.ceil(CLAUDE_URL.length / 80) }, (_, i) =>
  CLAUDE_URL.slice(i * 80, (i + 1) * 80),
);
const CLAUDE_INTRO = "Browser didn't open? Use the url below to sign in";
const CLAUDE_PROSE = 'Paste code here if prompted > ';

// Synthetic and shaped like `codex login --device-auth`: the URL on its own indented line, the
// one-time code on a later one.
const CODEX_URL = 'https://auth.openai.com/codex/device';
const CODEX_DEVICE_BANNER =
  '1. Open this link in your browser and sign in to your account\r\n' +
  `   \x1b[94m${CODEX_URL}\x1b[0m\r\n` +
  '\r\n' +
  '2. Enter this one-time code (expires in 15 minutes)\r\n' +
  '   \x1b[94mABCD-12345\x1b[0m\r\n';

interface ChunkedBanner {
  prefixes: string[];
  url: string;
  raw: string;
  /** Offset into `raw` from which what follows the URL shows that it has ended. */
  endsAt: number;
}

/** `body` is the URL as printed, wraps and colour included; `end` is what has to follow it before
 *  the URL is known to be complete. */
function chunkedBanner(
  prefixes: string[],
  url: string,
  raw: string,
  body: string,
  end: string,
): ChunkedBanner {
  return { prefixes, url, raw, endsAt: raw.indexOf(body) + body.length + end.length };
}

function wrappedClaudeBanner(head: string, body: string, end: string): ChunkedBanner {
  return chunkedBanner(
    CLAUDE_PREFIXES,
    CLAUDE_URL,
    `${head}${body}${end}${CLAUDE_PROSE}`,
    body,
    end,
  );
}

const AMP_DEVICE_URL = 'https://auth.ampcode.com/device?user_code=WMSD-BBRS';
const AMP_PASTE_URL = `${AMP_PASTE_LOGIN_URL_PREFIX}?authToken=${AMP_PASTE_TOKEN}`;
const GROK_DEVICE_URL = 'https://accounts.x.ai/oauth2/device?user_code=PZVK-REH7';

const CHUNKED_BANNERS = [
  [
    'claude, CRLF with colour around each line and a title before',
    wrappedClaudeBanner(
      `\x1b]0;Claude Code\x07${CLAUDE_INTRO}\r\n\r\n`,
      CLAUDE_LINES.map((line) => `\x1b[34m${line}\x1b[39m`).join('\r\n'),
      '\r\n\r\n',
    ),
  ],
  ['claude, bare LF', wrappedClaudeBanner(`${CLAUDE_INTRO}\n\n`, CLAUDE_LINES.join('\n'), '\n\n')],
  [
    'claude, cursor-forward indent on each line',
    wrappedClaudeBanner(
      `${CLAUDE_INTRO}\r\n\r\n`,
      CLAUDE_LINES.map((line) => `\x1b[2C${line}`).join('\r\n'),
      '\r\n\r\n',
    ),
  ],
  [
    'amp device',
    chunkedBanner(
      AUTH_URL_PREFIXES.amp ?? [],
      AMP_DEVICE_URL,
      AMP_DEVICE_BANNER,
      AMP_DEVICE_URL,
      '\x1b[22m\x1b[39m\r\n\r\n',
    ),
  ],
  [
    'amp paste-back',
    chunkedBanner(
      AUTH_URL_PREFIXES.amp ?? [],
      AMP_PASTE_URL,
      AMP_PASTE_BANNER,
      AMP_PASTE_URL,
      '\x1b[22m\x1b[39m\r\n\r\n',
    ),
  ],
  [
    'grok device',
    chunkedBanner(
      AUTH_URL_PREFIXES.grok ?? [],
      GROK_DEVICE_URL,
      GROK_DEVICE_BANNER,
      GROK_DEVICE_URL,
      '\n\n',
    ),
  ],
  [
    'codex device',
    chunkedBanner(
      AUTH_URL_PREFIXES.codex ?? [],
      CODEX_URL,
      CODEX_DEVICE_BANNER,
      CODEX_URL,
      '\x1b[0m\r\n\r\n',
    ),
  ],
] as const;

describe('extractWrappedUrl on output read in chunks', () => {
  const afterIntro = (tail: string) => `${CLAUDE_INTRO}\r\n\r\n${CLAUDE_URL}${tail}`;

  it.each(CHUNKED_BANNERS)('%s: every prefix of the output', (_label, banner) => {
    const strictWrong: number[] = [];
    const atEndWrong: number[] = [];
    for (let k = 0; k <= banner.raw.length; k++) {
      const cut = banner.raw.slice(0, k);
      const ended = k >= banner.endsAt;
      if (extractWrappedUrl(cut, banner.prefixes) !== (ended ? banner.url : null)) {
        strictWrong.push(k);
      }
      const atEnd = extractWrappedUrl(cut, banner.prefixes, true);
      const atEndOk = ended
        ? atEnd === banner.url
        : atEnd === null || (banner.url.startsWith(atEnd) && !/[\x1b[\s]/.test(atEnd));
      if (!atEndOk) atEndWrong.push(k);
    }
    expect(strictWrong).toEqual([]);
    expect(atEndWrong).toEqual([]);
  });

  it.each(['\n\n', '\r\n\r\n', '\n \n', '\x1b[39m\r\n\r\n', ' trailing prose', '\nprose here\n'])(
    'returns the URL strictly once %j follows it',
    (tail) => {
      expect(extractWrappedUrl(afterIntro(tail), CLAUDE_PREFIXES)).toBe(CLAUDE_URL);
    },
  );

  it.each(['', '\n', '\r\n', '\r\n\r', '\x1b', '\x1b[3', '\x1b[39m', '\x1b]0;t'])(
    'waits when only %j follows the URL, and takes the URL at the end of the text',
    (tail) => {
      expect(extractWrappedUrl(afterIntro(tail), CLAUDE_PREFIXES)).toBeNull();
      expect(extractWrappedUrl(afterIntro(tail), CLAUDE_PREFIXES, true)).toBe(CLAUDE_URL);
    },
  );

  it('does not return the 50-character head of a 65-character URL', () => {
    const url = 'https://claude.ai/oauth/authorize?code=true&client_id='.padEnd(65, 'a');
    expect(extractWrappedUrl(url.slice(0, 50), CLAUDE_PREFIXES)).toBeNull();
    expect(extractWrappedUrl(`${url}\n\n`, CLAUDE_PREFIXES)).toBe(url);
  });

  it('drops an unfinished escape after the URL instead of keeping "[3"', () => {
    expect(extractWrappedUrl(`${CLAUDE_URL}\x1b[3`, CLAUDE_PREFIXES, true)).toBe(CLAUDE_URL);
  });

  it('gives null for a prefix cut short', () => {
    const cut = 'https://claude.ai/oauth/auth';
    expect(extractWrappedUrl(cut, CLAUDE_PREFIXES)).toBeNull();
    expect(extractWrappedUrl(cut, CLAUDE_PREFIXES, true)).toBeNull();
  });

  it.each([
    ['one-line', CLAUDE_URL],
    ['hard-wrapped', CLAUDE_LINES.join('\n')],
  ])('does not append a prose line that follows a %s URL directly', (_label, printed) => {
    const raw = `${printed}\n${CLAUDE_PROSE}`;
    expect(extractWrappedUrl(raw, CLAUDE_PREFIXES)).toBe(CLAUDE_URL);
    expect(extractWrappedUrl(raw, CLAUDE_PREFIXES, true)).toBe(CLAUDE_URL);
  });
});
