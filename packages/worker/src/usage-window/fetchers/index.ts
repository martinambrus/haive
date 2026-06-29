import type { CliProviderName } from '@haive/shared';
import { CLAUDE_USAGE_OAUTH_SECRET } from '@haive/shared/claude-oauth';
import { rec, str, type UsageFetcher } from '../types.js';
import { fetchClaudeUsage } from './claude-code.js';
import { fetchCodexUsage } from './codex.js';
import { fetchZaiUsage } from './zai.js';
import { fetchGeminiUsage } from './gemini.js';

/** How the poller obtains a provider's bearer token. `secret` reads a decrypted
 *  cli_provider_secret (no container); `volumeJson` reads + parses a JSON file
 *  from the user's persistent auth volume via a helper container. */
export type UsageTokenSource =
  | { kind: 'secret'; secretName: string }
  | {
      kind: 'volumeJson';
      /** Index into the provider's authConfigPaths whose volume holds the file. */
      authPathIdx: number;
      /** File path relative to that auth dir (the volume root). */
      relPath: string;
      extract: (json: unknown) => { token: string | null; accountId?: string | null };
    }
  // A cli_provider_secret holding JSON-serialized ClaudeOauthTokens. The poller reads
  // it, refreshes the access token if near expiry (rotating + re-storing the secret),
  // and uses the (fresh) access token. Absent secret -> not connected -> chip hides.
  | { kind: 'oauthRefresh'; secretName: string };

export interface ProviderUsageConfig {
  fetch: UsageFetcher;
  token: UsageTokenSource;
}

/** Providers with a (vendor-confirmed but undocumented) usage-window endpoint.
 *  Absent providers (amp, ollama, antigravity) have no readable window -> the
 *  chip simply hides for them. */
export const USAGE_PROVIDERS: Partial<Record<CliProviderName, ProviderUsageConfig>> = {
  'claude-code': {
    fetch: fetchClaudeUsage,
    // NOT CLAUDE_CODE_OAUTH_TOKEN: that setup-token is user:inference-only and 403s on
    // the usage endpoint. This is the separately-minted user:profile PKCE token.
    token: { kind: 'oauthRefresh', secretName: CLAUDE_USAGE_OAUTH_SECRET },
  },
  zai: {
    fetch: fetchZaiUsage,
    token: { kind: 'secret', secretName: 'ANTHROPIC_AUTH_TOKEN' },
  },
  codex: {
    fetch: fetchCodexUsage,
    token: {
      kind: 'volumeJson',
      authPathIdx: 0, // ~/.codex
      relPath: 'auth.json',
      extract: (j) => {
        const tokens = rec(rec(j)?.['tokens']);
        return { token: str(tokens?.['access_token']), accountId: str(tokens?.['account_id']) };
      },
    },
  },
  gemini: {
    fetch: fetchGeminiUsage,
    token: {
      kind: 'volumeJson',
      authPathIdx: 1, // ~/.gemini (authConfigPaths = ['~/.config/gemini', '~/.gemini'])
      relPath: 'oauth_creds.json',
      extract: (j) => ({ token: str(rec(j)?.['access_token']) }),
    },
  },
};
