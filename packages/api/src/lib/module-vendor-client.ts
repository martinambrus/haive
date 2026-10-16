import type { IntegrationOperation } from '@haive/shared/modularity';
import type { IntegrationVendorClient, IntegrationVendorRequest } from '@haive/shared/module-host';

export type VendorReason =
  | 'vendor-host-refused'
  | 'vendor-method-refused'
  | 'vendor-redirect-refused'
  | 'vendor-auth'
  | 'vendor-not-found'
  | 'vendor-conflict'
  | 'vendor-rate-limited'
  | 'vendor-error';

export class VendorError extends Error {
  constructor(
    readonly reason: VendorReason,
    message: string,
  ) {
    super(message);
    this.name = 'VendorError';
  }
}

export const REDACTED = '[redacted]';
const RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const ERROR_BODY_MAX_BYTES = 4096;
// Volatile: undici's wording for a redirect refused under redirect 'error'; module-executors-support.test.ts measures it.
const REDIRECT_ERROR_TEXT = 'unexpected redirect';

const READ_METHODS = new Set(['GET', 'HEAD']);
const NOT_FORWARDED_HEADERS = new Set(['authorization', 'host']);

const hex = (value: number, width: number, upper: boolean): string => {
  const digits = value.toString(16).padStart(width, '0');
  return upper ? digits.toUpperCase() : digits;
};
const literal = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');

/** The ways a vendor's encoder may write one character: as is, as %XX or \uXXXX of either case, a slash as \/, each also read inside a JSON string. */
function spellings(char: string): string[] {
  if (/^[A-Za-z0-9]$/.test(char)) return [char];
  const bytes = [...Buffer.from(char)];
  const units = Array.from({ length: char.length }, (_, i) => char.charCodeAt(i));
  const written = [char, ...(char === '/' ? ['\\/'] : [])];
  for (const upper of [false, true]) {
    written.push(
      bytes.map((byte) => `%${hex(byte, 2, upper)}`).join(''),
      units.map((unit) => `\\u${hex(unit, 4, upper)}`).join(''),
    );
  }
  const forms = new Set(written.flatMap((form) => [form, JSON.stringify(form).slice(1, -1)]));
  return [...forms].sort((a, b) => b.length - a.length);
}

const patternOf = (secret: string): string =>
  [...secret]
    .map((char) => {
      const forms = spellings(char);
      return forms.length === 1 ? literal(forms[0]!) : `(?:${forms.map(literal).join('|')})`;
    })
    .join('');

/** The text without the start of the secret that a cut left at its end, a half-written escape included. */
function withoutStart(text: string, secret: string): string {
  const chars = [...secret].map(spellings);
  // Whether text[from:] spells the first characters of the secret, or stops inside the escape of one of them.
  const spellsToEnd = (from: number): boolean => {
    const open: Array<[number, number]> = [[from, 0]];
    for (let step = open.pop(); step !== undefined; step = open.pop()) {
      const [at, taken] = step;
      if (at === text.length) {
        if (taken > 0) return true;
        continue;
      }
      const forms = chars[taken];
      if (forms === undefined) continue;
      const left = text.length - at;
      if (forms.some((form) => left < form.length && form.startsWith(text.slice(at)))) {
        return true;
      }
      for (const form of forms) {
        if (text.startsWith(form, at)) open.push([at + form.length, taken + 1]);
      }
    }
    return false;
  };
  for (let from = 0; from < text.length; from += 1) {
    if (spellsToEnd(from)) return `${text.slice(0, from)}${REDACTED}`;
  }
  return text;
}

/** The text without the secrets as a vendor may echo them; with `cut`, also without the start of one a cut left at the end. */
export function redactSecrets(text: string, secrets: readonly string[], cut = false): string {
  const wanted = [...new Set(secrets)]
    .filter((secret) => secret !== '')
    .sort((a, b) => b.length - a.length);
  if (wanted.length === 0) return text;
  const out = text.replace(new RegExp(wanted.map(patternOf).join('|'), 'g'), REDACTED);
  return cut ? wanted.reduce(withoutStart, out) : out;
}

async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; cut: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: '', cut: false };
  const decoder = new TextDecoder();
  let text = '';
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { text: text + decoder.decode(), cut: false };
    const room = maxBytes - read;
    if (value.byteLength > room) {
      text += decoder.decode(value.subarray(0, room));
      await reader.cancel();
      return { text, cut: true };
    }
    read += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
}

function reasonOf(status: number): VendorReason {
  if (status >= 300 && status < 400) return 'vendor-redirect-refused';
  if (status === 401 || status === 403) return 'vendor-auth';
  if (status === 404) return 'vendor-not-found';
  if (status === 409 || status === 422) return 'vendor-conflict';
  if (status === 429) return 'vendor-rate-limited';
  return 'vendor-error';
}

function isJson(response: Response): boolean {
  const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  return type === 'application/json' || type.endsWith('+json');
}

function targetOf(raw: string, apiHosts: readonly string[]): URL {
  const refused = new VendorError(
    'vendor-host-refused',
    'the request was refused: it is not an https url, on the default port, of a host this provider declares',
  );
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw refused;
  }
  if (url.protocol !== 'https:' || url.port !== '' || !apiHosts.includes(url.hostname)) {
    throw refused;
  }
  return url;
}

/** Sends a module's requests with this connection's token alone, to the provider's declared hosts alone. */
export function createVendorClient(options: {
  token: string;
  apiHosts: readonly string[];
  access: IntegrationOperation['access'];
  signal: AbortSignal;
}): IntegrationVendorClient {
  const { token, apiHosts, access, signal } = options;
  // A deadline abort is the caller's to read; any other failure is the vendor's.
  const failed = (err: unknown): unknown => {
    if (signal.aborted) return err;
    if (
      err instanceof TypeError &&
      (err.cause as Error | undefined)?.message === REDIRECT_ERROR_TEXT
    ) {
      return new VendorError('vendor-redirect-refused', 'the vendor answered with a redirect');
    }
    return new VendorError('vendor-error', 'the vendor could not be reached');
  };

  return {
    async request(request: IntegrationVendorRequest) {
      const target = targetOf(request.url, apiHosts);
      if (access !== 'write' && !READ_METHODS.has(request.method.toUpperCase())) {
        throw new VendorError(
          'vendor-method-refused',
          'the request was refused: a read operation sends GET or HEAD only',
        );
      }
      for (const [name, value] of Object.entries(request.query ?? {})) {
        target.searchParams.set(name, value);
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers ?? {})) {
        if (!NOT_FORWARDED_HEADERS.has(name.toLowerCase())) headers.set(name, value);
      }
      try {
        headers.set('authorization', `Bearer ${token}`);
      } catch {
        // The error of a header the platform refuses quotes its value, the token among it.
        throw new VendorError('vendor-error', 'the access token of this connection cannot be sent');
      }
      if (request.json !== undefined) headers.set('content-type', 'application/json');

      let response: Response;
      let read: { text: string; cut: boolean };
      try {
        response = await fetch(target, {
          method: request.method,
          headers,
          body: request.json === undefined ? undefined : JSON.stringify(request.json),
          redirect: 'error',
          signal,
        });
        read = await readBounded(response, response.ok ? RESPONSE_MAX_BYTES : ERROR_BODY_MAX_BYTES);
      } catch (err) {
        throw failed(err);
      }

      const { status } = response;
      if (!response.ok) {
        const detail = redactSecrets(read.text, [token], read.cut).trim();
        throw new VendorError(
          reasonOf(status),
          `the vendor answered ${status}${detail === '' ? '' : `: ${detail}`}`,
        );
      }
      if (read.cut) {
        throw new VendorError('vendor-error', 'the answer of the vendor is larger than the limit');
      }
      // The executor never holds the token, not even one the vendor echoes in its answer.
      const text = redactSecrets(read.text, [token]);
      if (text === '' || !isJson(response)) return { status, body: text };
      try {
        return { status, body: JSON.parse(text) as unknown };
      } catch {
        throw new VendorError('vendor-error', 'the vendor answered JSON that cannot be read');
      }
    },
  };
}
