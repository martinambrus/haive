import type { ForgeProviderName } from '@haive/shared';

export type { ForgeProviderName };

/** Everything a forge adapter needs to make one authenticated PR/MR call for a repo.
 *  Built by resolveForgeContext from the repo's remote URL + its bound credential. */
export interface ForgeContext {
  provider: ForgeProviderName;
  /** REST API base URL, no trailing slash (e.g. https://api.github.com,
   *  https://gitea.example.com/api/v1, https://gitlab.example.com/api/v4). */
  apiBase: string;
  /** Web host parsed from the remote URL (e.g. github.com, git.acme.com[:port]). */
  host: string;
  /** Repo owner / org / workspace / project key, parsed from the remote URL.
   *  For GitLab this may be a nested group path (group/subgroup). */
  owner: string;
  /** Repo name / slug, parsed from the remote URL (no .git suffix). */
  repo: string;
  /** The API token (the decrypted credential secret). */
  token: string;
  /** Credential username, needed only for Basic auth (Bitbucket Cloud app passwords). */
  username: string;
}

export interface OpenPrInput {
  /** Source (feature) branch. */
  head: string;
  /** Target (base) branch. */
  base: string;
  title: string;
  body: string;
}

export interface OpenPrResult {
  /** Web URL of the opened (or already-existing) PR/MR. */
  url: string;
  /** Forge PR identifier as a string (GitHub/Gitea number, GitLab iid, Bitbucket id). */
  number: string;
}

/** Normalised PR lifecycle. `closed` = closed without merging (declined/rejected). */
export type PrLifecycle = 'open' | 'merged' | 'closed';

export interface PrStateResult {
  state: PrLifecycle;
  mergedAt: Date | null;
}

export interface ForgeProvider {
  readonly name: ForgeProviderName;
  /** Default REST API base for a web host (per-provider convention). Overridden by
   *  the credential's api_base_url for self-hosted subpath/reverse-proxy installs. */
  defaultApiBase(host: string): string;
  openPullRequest(ctx: ForgeContext, input: OpenPrInput): Promise<OpenPrResult>;
  getPullRequestState(ctx: ForgeContext, prNumber: string): Promise<PrStateResult>;
}

// --- Typed errors ----------------------------------------------------------
// Let callers distinguish an unauthorized/under-scoped token (surface "reconnect")
// from a missing repo, a create conflict (PR already exists), or a transient
// rate-limit (back off and retry next tick).

export class ForgeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ForgeError';
  }
}

export class ForgeAuthError extends ForgeError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = 'ForgeAuthError';
  }
}

export class ForgeNotFoundError extends ForgeError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = 'ForgeNotFoundError';
  }
}

/** 409/422: the create was rejected — usually because a PR for this head→base
 *  already exists. Adapters try to find and return the existing PR before this
 *  reaches a caller. */
export class ForgeConflictError extends ForgeError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = 'ForgeConflictError';
  }
}

export class ForgeRateLimitError extends ForgeError {
  constructor(
    message: string,
    status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message, status);
    this.name = 'ForgeRateLimitError';
  }
}
