import type { CliProviderName } from '@haive/shared';
import { rec, str } from './types.js';

/** Where a CLI keeps the credential file it REFRESHES IN PLACE, and how to pull the
 *  identity-bearing token out of it.
 *
 *  Two consumers, deliberately one registry:
 *   - the usage poller reads it off the USER volume to get a bearer token
 *     (USAGE_PROVIDERS' `volumeJson` entries point here);
 *   - the task-end auth sync reads it off both volumes to decide whether the in-task CLI
 *     rotated the credential and the user volume must be updated
 *     (syncRefreshedAuthToUserVolumes).
 *
 *  It used to live only on USAGE_PROVIDERS, which silently coupled "Haive protects this
 *  CLI's credential from rotting" to "this CLI exposes a usage-window endpoint". grok has
 *  no usage endpoint, so it was absent from that map and its refreshed token was never
 *  carried back — the user volume kept a spent refresh token and an expired access token
 *  until grok gave up and DELETED auth.json. Membership here is about the credential, not
 *  about metering; do not re-merge the two. */
export interface CliCredentialFile {
  /** Index into the provider's `authConfigPaths` whose volume holds the file. */
  authPathIdx: number;
  /** File path relative to that auth dir (the volume root). */
  relPath: string;
  extract: (json: unknown) => { token: string | null; accountId?: string | null };
}

export const CODEX_CREDENTIAL_FILE: CliCredentialFile = {
  authPathIdx: 0, // ~/.codex
  relPath: 'auth.json',
  extract: (j) => {
    const tokens = rec(rec(j)?.['tokens']);
    return { token: str(tokens?.['access_token']), accountId: str(tokens?.['account_id']) };
  },
};

export const GEMINI_CREDENTIAL_FILE: CliCredentialFile = {
  authPathIdx: 1, // ~/.gemini (authConfigPaths = ['~/.config/gemini', '~/.gemini'])
  relPath: 'oauth_creds.json',
  extract: (j) => ({ token: str(rec(j)?.['access_token']) }),
};

export const GROK_CREDENTIAL_FILE: CliCredentialFile = {
  authPathIdx: 0, // ~/.grok
  relPath: 'auth.json',
  // The file is a map keyed by "<oidc_issuer>::<oidc_client_id>", e.g.
  // "https://auth.x.ai::b1a00492-...", so there is no fixed path to the entry — take the
  // first value that carries a `key` (grok's name for the access token). Multiple entries
  // only appear for enterprise OIDC, where any of them proves the file changed, which is
  // all the sync needs.
  extract: (j) => {
    const root = rec(j);
    if (!root) return { token: null };
    for (const value of Object.values(root)) {
      const token = str(rec(value)?.['key']);
      if (token) return { token };
    }
    return { token: null };
  },
};

export const CLI_CREDENTIAL_FILES: Partial<Record<CliProviderName, CliCredentialFile>> = {
  codex: CODEX_CREDENTIAL_FILE,
  gemini: GEMINI_CREDENTIAL_FILE,
  grok: GROK_CREDENTIAL_FILE,
};
