import type { CliCommandSpec, CliProviderName, CliProviderRecord } from './types.js';

export class CliSetupTokenUnsupportedError extends Error {
  readonly code = 'cli_setup_token_unsupported';
  constructor(providerName: CliProviderName) {
    super(`setup-token flow not implemented for provider ${providerName}`);
    this.name = 'CliSetupTokenUnsupportedError';
  }
}

export function isCliSetupTokenSupported(name: CliProviderName): boolean {
  return name === 'claude-code' || name === 'codex' || name === 'amp' || name === 'antigravity';
}

/** Non-REPL auth command that prints an OAuth URL to stdout:
 *  - claude-code: `claude setup-token` — prints URL, expects pasted token on stdin.
 *  - codex: `codex login --device-auth` — prints URL + short device code, polls for approval.
 *  - amp: `amp login` — prints an ampcode.com/auth/cli-login URL with an
 *    authToken query param, then reads a paste-back code from stdin. The user
 *    signs in at ampcode.com, the confirmation page shows a code, they paste
 *    it into the banner modal, and we forward it to the container's stdin.
 *    Success is detected by polling for ~/.config/amp/settings.json.
 *  - antigravity: `agy -i <prompt>` (interactive TUI) — agy has no login
 *    subcommand; first run with no creds prints a Google OAuth URL and reads the
 *    pasted authorization code on stdin. agy's auth is a full-screen TUI the URL
 *    extractor can't parse, and `-p` caps the auth wait at ~30s, so for
 *    antigravity the cli-login-banner runs in terminal-passthrough mode and the
 *    login modal renders this TUI in an xterm terminal — the user completes the
 *    OAuth + code paste themselves, unhurried. The login container's headless env
 *    makes agy print the URL instead of opening a browser. Success = the token
 *    file ~/.gemini/antigravity-cli/antigravity-oauth-token, detected by the poller.
 *  Other providers: throws CliSetupTokenUnsupportedError.
 */
export function buildSetupTokenCommand(
  provider: CliProviderRecord,
  executable: string,
): CliCommandSpec {
  const env = provider.envVars ?? {};
  switch (provider.name) {
    case 'claude-code':
      return { command: executable, args: ['setup-token'], env };
    case 'codex':
      return { command: executable, args: ['login', '--device-auth'], env };
    case 'amp':
      return { command: executable, args: ['login'], env };
    case 'antigravity':
      // Interactive agy (TUI). The cli-login-banner runs this in
      // terminal-passthrough mode and the login modal renders it in an xterm, so
      // the user completes the OAuth + code paste interactively at their own pace
      // (no URL extraction, no 30s -p cap). The login container's HEADLESS_AUTH_ENV
      // (BROWSER=/bin/false, DISPLAY=) makes agy print the URL rather than open a
      // browser. The trivial initial prompt drives the first-run auth gate.
      return { command: executable, args: ['-i', 'respond with the word ready'], env };
    default:
      throw new CliSetupTokenUnsupportedError(provider.name);
  }
}
