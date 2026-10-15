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

    const signal = AbortSignal.timeout(this.timeoutMs);
    const failure = (err: unknown): ForgeError =>
      new ForgeError(
        signal.aborted
          ? `${this.name} request timed out after ${this.timeoutMs} ms (${method} ${path})`
          : `${this.name} request failed (${method} ${path}): ${err instanceof Error ? err.message : String(err)}`,
      );

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
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw failure(err);
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ForgeError(`${this.name} returned a non-JSON response for ${method} ${path}`);
    }
  }
}

async function readBodyText(res: Response): Promise<string> {
  try {
    const t = (await res.text()).trim();
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
