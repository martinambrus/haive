import type { CliProviderName } from '../types/index.js';

const ANSI_CSI = /\x1b\[[\x20-\x3f]*[\x40-\x7e]/g;
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_SHORT = /\x1b[^[\]]/g;
const ANSI_CUF = /\x1b\[(\d*)C/g;

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
  gemini: ['https://accounts.google.com/o/oauth2/'],
  amp: ['https://ampcode.com/auth/cli-login'],
};

export const TOKEN_PASTE_PROVIDERS: ReadonlySet<CliProviderName> = new Set<CliProviderName>([
  'claude-code',
  'gemini',
  'amp',
]);

export function extractWrappedUrl(raw: string, prefixes: string[]): string | null {
  const clean = stripAnsi(raw);
  const lines = clean.split(/\r?\n/);
  let url = '';
  let capturing = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!capturing) {
      for (const prefix of prefixes) {
        const idx = trimmed.indexOf(prefix);
        if (idx >= 0) {
          capturing = true;
          url = trimmed.slice(idx);
          break;
        }
      }
    } else {
      if (trimmed === '') break;
      url += trimmed;
    }
  }
  return url || null;
}

const DEVICE_CODE_PATTERN = /\b([A-Z0-9]{4,6}-[A-Z0-9]{4,6})\b/;

export function extractDeviceCode(raw: string): string | undefined {
  const spaced = ansiToSpaces(raw);
  const match = spaced.match(DEVICE_CODE_PATTERN);
  return match?.[1];
}

const GEMINI_URL_PREAMBLE = /please\s+visit\s+the\s+following\s+url\s+to\s+authorize/i;

export function extractGeminiAuthUrl(raw: string): string | null {
  const clean = stripAnsi(raw);
  const match = clean.match(GEMINI_URL_PREAMBLE);
  if (!match || match.index === undefined) return null;
  const tail = clean.slice(match.index + match[0].length);
  const prefixes = AUTH_URL_PREFIXES.gemini ?? [];
  return extractWrappedUrl(tail, prefixes);
}

export interface AuthResultSignal {
  kind: 'success' | 'error';
  message?: string;
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
    const errorLine = clean.split('\n').find((l) => /invalid|failed|expired/i.test(l));
    return { kind: 'error', message: (errorLine?.trim() ?? 'Authentication failed').slice(0, 200) };
  }
  return null;
}
