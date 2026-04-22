import type { CliCommandSpec, CliProviderName, CliProviderRecord } from './types.js';

export class CliSetupTokenUnsupportedError extends Error {
  readonly code = 'cli_setup_token_unsupported';
  constructor(providerName: CliProviderName) {
    super(`setup-token flow not implemented for provider ${providerName}`);
    this.name = 'CliSetupTokenUnsupportedError';
  }
}

export function isCliSetupTokenSupported(name: CliProviderName): boolean {
  return name === 'claude-code' || name === 'codex' || name === 'gemini' || name === 'amp';
}

const GEMINI_SETTINGS_JSON =
  '{"selectedAuthType":"oauth-personal","security":{"auth":{"selectedType":"oauth-personal"}}}';

/** Non-REPL auth command that prints an OAuth URL to stdout:
 *  - claude-code: `claude setup-token` — prints URL, expects pasted token on stdin.
 *  - codex: `codex login --device-auth` — prints URL + short device code, polls for approval.
 *  - gemini: pre-seed ~/.gemini/settings.json with selectedAuthType=oauth-personal
 *    (both flat and nested schemas) so the REPL skips the auth picker, then
 *    exec gemini with NO_BROWSER=true. In a headless TTY container gemini's
 *    OAuth module takes the `authWithUserCode` branch — prints the authorize
 *    URL to stdout, then reads the authorization code via readline on stdin.
 *    The user signs in at Google, copies the code shown on
 *    codeassist.google.com/authcode, pastes it into the banner modal, and we
 *    write it to the container's stdin as-if typed at the readline prompt.
 *    Success is detected by polling for ~/.gemini/{oauth_creds,gemini-credentials}.json.
 *  - amp: `amp login` — prints an ampcode.com/auth/cli-login URL with an
 *    authToken query param, then reads a paste-back code from stdin. The user
 *    signs in at ampcode.com, the confirmation page shows a code, they paste
 *    it into the banner modal, and we forward it to the container's stdin.
 *    Success is detected by polling for ~/.config/amp/settings.json.
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
    case 'gemini': {
      const script =
        'mkdir -p "$HOME/.gemini" && ' +
        `cat > "$HOME/.gemini/settings.json" <<'EOF'\n${GEMINI_SETTINGS_JSON}\nEOF\n` +
        'exec "$0"';
      return {
        command: 'sh',
        args: ['-c', script, executable],
        env: {
          ...env,
          NO_BROWSER: 'true',
        },
      };
    }
    case 'amp':
      return { command: executable, args: ['login'], env };
    default:
      throw new CliSetupTokenUnsupportedError(provider.name);
  }
}
