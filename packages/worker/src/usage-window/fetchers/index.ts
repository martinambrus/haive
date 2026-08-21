import type { CliProviderName, UsageWindowProviderName } from '@haive/shared';
import { CLAUDE_USAGE_OAUTH_SECRET } from '@haive/shared/claude-oauth';
import {
  CODEX_CREDENTIAL_FILE,
  GEMINI_CREDENTIAL_FILE,
  type CliCredentialFile,
} from '../credential-files.js';
import { type UsageFetcher } from '../types.js';
import { fetchClaudeUsage } from './claude-code.js';
import { fetchCodexUsage } from './codex.js';
import { fetchZaiUsage } from './zai.js';
import { fetchGeminiUsage } from './gemini.js';

/** How the poller obtains a provider's bearer token. `secret` reads a decrypted
 *  cli_provider_secret (no container); `volumeJson` reads + parses a JSON file
 *  from the user's persistent auth volume via a helper container. */
export type UsageTokenSource =
  | { kind: 'secret'; secretName: string }
  // Structurally `CliCredentialFile` + a tag. The fields are spread in from
  // CLI_CREDENTIAL_FILES rather than written out per provider, because the task-end auth
  // sync reads the same descriptors and the two must never drift apart.
  | ({ kind: 'volumeJson' } & CliCredentialFile)
  // A cli_provider_secret holding JSON-serialized ClaudeOauthTokens. The poller reads
  // it, refreshes the access token if near expiry (rotating + re-storing the secret),
  // and uses the (fresh) access token. Absent secret -> not connected -> chip hides.
  | { kind: 'oauthRefresh'; secretName: string };

export interface ProviderUsageConfig {
  fetch: UsageFetcher;
  token: UsageTokenSource;
  /** false = this provider has no in-product path to fix a rejected usage token, so a
   *  persistent auth denial records a hidden `error` rather than nagging `needs_reconnect`.
   *  Used for the volumeJson CLIs (codex/gemini) whose cached access token expires benignly
   *  when the CLI is idle and is refreshed by the CLI itself on its next run. Defaults to
   *  reconnectable (claude usage-OAuth re-auth; zai token edit). */
  reconnectable?: boolean;
}

/** Providers with a (vendor-confirmed but undocumented) usage-window endpoint.
 *  Absent providers (amp, ollama, grok, antigravity) have no readable window -> the
 *  chip simply hides for them.
 *
 *  `satisfies` against the shared union is a drift guard, not decoration: the WEB keeps its own
 *  map of the same CLIs (lib/usage-chip-state) to tell "no endpoint exists" from "endpoint
 *  exists but this provider never reported", and it cannot import this file. Adding a fetcher
 *  here without adding the name to USAGE_WINDOW_PROVIDERS fails to compile here; adding it
 *  there without a fetcher fails to compile in web. */
const FETCHERS = {
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
    // No in-product reconnect: codex's cached access token expires when idle and the CLI
    // refreshes it on its next run. The poller cannot safely refresh it (single-use OpenAI
    // refresh tokens; per-task auth-copy divergence), so a denial hides the chip, never nags.
    reconnectable: false,
    token: { kind: 'volumeJson', ...CODEX_CREDENTIAL_FILE },
  },
  gemini: {
    fetch: fetchGeminiUsage,
    // No wired gemini login in Haive (default auth mode is api_key); oauth_creds.json exists
    // only if the user logged the CLI in outside Haive, and its access token expires when idle.
    // A denial hides the chip rather than prompting a reconnect the user can't perform here.
    reconnectable: false,
    token: { kind: 'volumeJson', ...GEMINI_CREDENTIAL_FILE },
  },
} satisfies Record<UsageWindowProviderName, ProviderUsageConfig>;

/** Widened for lookup: callers index by a plain CliProviderName and check for undefined.
 *  FETCHERS above carries the exhaustiveness check; this is the same object. */
export const USAGE_PROVIDERS: Partial<Record<CliProviderName, ProviderUsageConfig>> = FETCHERS;
