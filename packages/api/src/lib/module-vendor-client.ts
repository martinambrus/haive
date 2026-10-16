import type { IntegrationVendorClient, IntegrationVendorRequest } from '@haive/shared/module-host';

export type VendorReason =
  | 'vendor-host-refused'
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

/** The token as a vendor may echo it: as is, JSON-escaped and URL-encoded, longest first. */
export const tokenForms = (token: string): string[] =>
  [...new Set([token, JSON.stringify(token).slice(1, -1), encodeURIComponent(token)])]
    .filter((form) => form !== '')
    .sort((a, b) => b.length - a.length);

/** The text without the token, and without a start of it that a cut read left at the end. */
function scrub(text: string, forms: readonly string[], cut: boolean): string {
  let out = forms.reduce((acc, form) => acc.split(form).join(REDACTED), text);
  if (!cut) return out;
  for (const form of forms) {
    for (let k = Math.min(form.length - 1, out.length); k > 0; k -= 1) {
      if (out.endsWith(form.slice(0, k))) {
        out = `${out.slice(0, -k)}${REDACTED}`;
        break;
      }
    }
  }
  return out;
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
    'the request was refused: it is not an https url of a host this provider declares',
  );
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw refused;
  }
  if (url.protocol !== 'https:' || !apiHosts.includes(url.hostname)) throw refused;
  return url;
}

/** Sends a module's requests with this connection's token alone, to the provider's declared hosts alone. */
export function createVendorClient(options: {
  token: string;
  apiHosts: readonly string[];
  signal: AbortSignal;
}): IntegrationVendorClient {
  const { token, apiHosts, signal } = options;
  const forms = tokenForms(token);
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
      for (const [name, value] of Object.entries(request.query ?? {})) {
        target.searchParams.set(name, value);
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers ?? {})) {
        if (name.toLowerCase() !== 'authorization') headers.set(name, value);
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
        const detail = scrub(read.text, forms, read.cut).trim();
        throw new VendorError(
          reasonOf(status),
          `the vendor answered ${status}${detail === '' ? '' : `: ${detail}`}`,
        );
      }
      if (read.cut) {
        throw new VendorError('vendor-error', 'the answer of the vendor is larger than the limit');
      }
      if (read.text === '' || !isJson(response)) return { status, body: read.text };
      try {
        return { status, body: JSON.parse(read.text) as unknown };
      } catch {
        throw new VendorError('vendor-error', 'the vendor answered JSON that cannot be read');
      }
    },
  };
}
