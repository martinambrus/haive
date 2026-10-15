import type {
  ForgeContext,
  ForgeProvider,
  ForgeProviderName,
  OpenPrInput,
  OpenPrResult,
  PrStateResult,
} from './types.js';
import {
  ForgeAuthError,
  ForgeConflictError,
  ForgeError,
  ForgeNotFoundError,
  ForgeRateLimitError,
} from './types.js';

export const FORGE_REQUEST_TIMEOUT_MS = 30_000;
// An open-PR lookup on Gitea or Bitbucket Server reads a whole page of pull requests, bodies included.
export const FORGE_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const ERROR_BODY_MAX_BYTES = 4096;

/** Shared base for the forge adapters. Provides one authenticated JSON request
 *  helper that maps HTTP failures to typed ForgeErrors; subclasses supply their
 *  auth header and the endpoint shapes. Never logs the token. */
export abstract class BaseForgeProvider implements ForgeProvider {
  constructor(private readonly timeoutMs: number = FORGE_REQUEST_TIMEOUT_MS) {}

  abstract readonly name: ForgeProviderName;
  abstract defaultApiBase(host: string): string;
  abstract openPullRequest(ctx: ForgeContext, input: OpenPrInput): Promise<OpenPrResult>;
  abstract getPullRequestState(ctx: ForgeContext, prNumber: string): Promise<PrStateResult>;

  /** Per-provider authentication header(s) for the REST call. */
  protected abstract authHeaders(ctx: ForgeContext): Record<string, string>;

  protected async request<T>(
    ctx: ForgeContext,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${ctx.apiBase}${path}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'haive',
      ...this.authHeaders(ctx),
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = ctx.signal ? AbortSignal.any([timeout, ctx.signal]) : timeout;
    const failure = (err: unknown): ForgeError => {
      if (timeout.aborted) {
        return new ForgeError(
          `${this.name} request timed out after ${this.timeoutMs} ms (${method} ${path})`,
        );
      }
      if (signal.aborted) {
        return new ForgeError(`${this.name} request was cancelled (${method} ${path})`);
      }
      return new ForgeError(
        `${this.name} request failed (${method} ${path}): ${err instanceof Error ? err.message : String(err)}`,
      );
    };

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw failure(err);
    }

    if (!res.ok) {
      throw mapHttpError(this.name, res.status, res.headers, await readBodyText(res), method, path);
    }

    if (res.status === 204) return undefined as T;
    let answer: { text: string; truncated: boolean };
    try {
      answer = await readBounded(res, FORGE_RESPONSE_MAX_BYTES);
    } catch (err) {
      throw failure(err);
    }
    if (answer.truncated) {
      throw new ForgeError(
        `${this.name} response for ${method} ${path} is larger than ${FORGE_RESPONSE_MAX_BYTES} bytes`,
      );
    }
    if (!answer.text) return undefined as T;
    try {
      return JSON.parse(answer.text) as T;
    } catch {
      throw new ForgeError(`${this.name} returned a non-JSON response for ${method} ${path}`);
    }
  }
}

async function readBounded(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: '', truncated: false };
  const decoder = new TextDecoder();
  let text = '';
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { text: text + decoder.decode(), truncated: false };
    const room = maxBytes - read;
    if (value.byteLength > room) {
      text += decoder.decode(value.subarray(0, room));
      await reader.cancel();
      return { text, truncated: true };
    }
    read += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
}

async function readBodyText(res: Response): Promise<string> {
  try {
    const t = (await readBounded(res, ERROR_BODY_MAX_BYTES)).text.trim();
    return t.length > 500 ? `${t.slice(0, 500)}…` : t;
  } catch {
    return '';
  }
}

function mapHttpError(
  name: ForgeProviderName,
  status: number,
  headers: Headers,
  detail: string,
  method: string,
  path: string,
): ForgeError {
  const where = `${name} ${method} ${path} -> HTTP ${status}`;
  if (status === 401 || status === 403) {
    return new ForgeAuthError(
      `${where}: the token is unauthorized or lacks pull-request scope. ${detail}`.trim(),
      status,
    );
  }
  if (status === 404) {
    return new ForgeNotFoundError(`${where}: not found. ${detail}`.trim(), status);
  }
  if (status === 409 || status === 422) {
    return new ForgeConflictError(`${where}: ${detail}`.trim(), status);
  }
  if (status === 429) {
    const retry = Number(headers.get('retry-after'));
    return new ForgeRateLimitError(
      `${where}: rate-limited. ${detail}`.trim(),
      status,
      Number.isFinite(retry) && retry > 0 ? retry * 1000 : undefined,
    );
  }
  return new ForgeError(`${where}: ${detail}`.trim(), status);
}
