import type { CliProviderName } from '../types/index.js';

const ANSI_CSI = /\x1b\[[\x20-\x3f]*[\x40-\x7e]/g;
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_SHORT = /\x1b[^[\]]/g;
const ANSI_CUF = /\x1b\[(\d*)C/g;

/** An escape sequence the text ends in the middle of: a bare ESC, a CSI without its final byte
 *  or an OSC without its terminator. Output read in chunks can stop inside one. */
export const INCOMPLETE_ANSI_ESCAPE = /\x1b(?:\[[\x20-\x3f]*|\][^\x07\x1b]*\x1b?)?$/;

export function stripAnsi(str: string): string {
  return str
    .replace(ANSI_CUF, (_, n) => ' '.repeat(parseInt(n || '1', 10)))
    .replace(ANSI_CSI, '')
    .replace(ANSI_OSC, '')
    .replace(ANSI_SHORT, '')
    .replace(/\x1b/g, '');
}

export function ansiToSpaces(str: string): string {
  return str
    .replace(ANSI_CUF, (_, n) => ' '.repeat(parseInt(n || '1', 10)))
    .replace(ANSI_CSI, ' ')
    .replace(ANSI_OSC, ' ')
    .replace(ANSI_SHORT, ' ')
    .replace(/\x1b/g, '')
    .replace(/ {2,}/g, ' ');
}

/** amp's paste-back login page. amp prints this URL only on versions before
 *  0.0.1789200043; newer ones print an auth.ampcode.com device URL instead.
 *  A login session picks its flow by testing the URL the CLI actually printed
 *  against this prefix, because the version behind a provider is a user pin and
 *  both shapes stay reachable. */
export const AMP_PASTE_LOGIN_URL_PREFIX = 'https://ampcode.com/auth/cli-login';

export const AUTH_URL_PREFIXES: Partial<Record<CliProviderName, string[]>> = {
  'claude-code': [
    'https://claude.com/cai/oauth/authorize',
    'https://claude.ai/oauth/authorize',
    'https://console.anthropic.com/',
  ],
  codex: [
    'https://auth.openai.com/',
    'https://platform.openai.com/',
    'https://login.openai.com/',
    'https://chatgpt.com/',
  ],
  // MEASURED against real `amp login` runs on both shapes: 0.0.1789200043-gdb3b35
  // retired the paste-back cli-login page for an OAuth DEVICE flow and prints
  // `https://auth.ampcode.com/device?user_code=XXXX-XXXX`, while 0.0.1786896116
  // still prints the cli-login page. The CLI VERSION is a per-provider pin, so
  // both are live and both prefixes have to stay. The bare host sits between
  // them so a device-path change still resolves to a usable URL. Which flow a
  // session is in is read off the URL — see AMP_PASTE_LOGIN_URL_PREFIX.
  amp: ['https://auth.ampcode.com/device', 'https://auth.ampcode.com/', AMP_PASTE_LOGIN_URL_PREFIX],
  // Antigravity (agy) prints Google's OAuth endpoint.
  antigravity: ['https://accounts.google.com/o/oauth2/'],
  // MEASURED from a real `grok login --device-auth`, not from xAI's docs, which
  // talk about auth.x.ai: the device flow prints
  // `https://accounts.x.ai/oauth2/device?user_code=XXXX-XXXX`. The bare host is
  // kept as a second prefix so a path change still resolves to a usable URL.
  grok: ['https://accounts.x.ai/oauth2/device', 'https://accounts.x.ai/'],
};

/** Providers whose login is ALWAYS a paste-back: the CLI prints a URL and then
 *  reads a token or code from stdin. Membership gates `canDetect`, so a provider
 *  listed here is only inspected for success after a token is submitted.
 *
 *  amp is deliberately absent even though an older pinned version still pastes
 *  back: its flow is per-VERSION, and this set is per-PROVIDER. A login session
 *  resolves amp from the URL it printed (AMP_PASTE_LOGIN_URL_PREFIX) and that
 *  answer overrides this set, so the default here only has to be right for the
 *  current CLI. */
export const TOKEN_PASTE_PROVIDERS: ReadonlySet<CliProviderName> = new Set<CliProviderName>([
  'claude-code',
  'antigravity',
]);

/** The auth URL in `raw`, which is output read in chunks and so may stop at any byte. A URL can be
 *  hard-wrapped over several lines, so it is returned only once something after it shows that it
 *  has ended: more text after it on its line, a blank line, or a line that holds whitespace
 *  (prose; a wrapped URL continues on whitespace-free lines). Blanks alone do not end it, because
 *  a wrapped line can be padded. Output that stops inside it gives null, because the next chunk
 *  may continue it.
 *
 *  `atEnd` takes the end of the text as the end of the URL, for a stream that ended or went quiet.
 *  A whitespace-free last line is then kept, since it may be the tail of a wrapped URL as well as
 *  the first word of a line of prose. The same ambiguity joins a whitespace-free line directly
 *  under the URL, and text on the same line as the last piece of a wrapped URL cuts that piece off. */
export function extractWrappedUrl(raw: string, prefixes: string[], atEnd = false): string | null {
  const lines = stripAnsi(raw.replace(INCOMPLETE_ANSI_ESCAPE, '')).split(/\r?\n/);
  let url = '';
  let capturing = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (capturing) {
      // The empty text after the last newline is an unfinished line, not a blank one.
      if (trimmed === '') return i < lines.length - 1 || atEnd ? url : null;
      if (/\s/.test(trimmed)) return url;
      url += trimmed;
      continue;
    }
    for (const prefix of prefixes) {
      const idx = trimmed.indexOf(prefix);
      if (idx < 0) continue;
      const rest = trimmed.slice(idx);
      const space = rest.search(/\s/);
      if (space >= 0) return rest.slice(0, space);
      capturing = true;
      url = rest;
      break;
    }
  }
  return atEnd && url ? url : null;
}

const DEVICE_CODE_PATTERN = /\b([A-Z0-9]{4,6}-[A-Z0-9]{4,6})\b/;

export function extractDeviceCode(raw: string): string | undefined {
  const spaced = ansiToSpaces(raw);
  const match = spaced.match(DEVICE_CODE_PATTERN);
  return match?.[1];
}

export interface AuthResultSignal {
  kind: 'success' | 'error';
}

export function detectAuthResult(clean: string): AuthResultSignal | null {
  const lower = clean.toLowerCase();
  if (
    lower.includes('token saved') ||
    lower.includes('successfully authenticated') ||
    lower.includes('authentication complete') ||
    lower.includes('logged in') ||
    lower.includes('login successful') ||
    lower.includes('token is valid') ||
    lower.includes('signed in')
  ) {
    return { kind: 'success' };
  }
  if (
    lower.includes('invalid token') ||
    lower.includes('authentication failed') ||
    lower.includes('login failed') ||
    lower.includes('token expired')
  ) {
    return { kind: 'error' };
  }
  return null;
}
