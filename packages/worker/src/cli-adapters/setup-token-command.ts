import type { CliCommandSpec, CliProviderName, CliProviderRecord } from './types.js';

export class CliSetupTokenUnsupportedError extends Error {
  readonly code = 'cli_setup_token_unsupported';
  constructor(providerName: CliProviderName) {
    super(`setup-token flow not implemented for provider ${providerName}`);
    this.name = 'CliSetupTokenUnsupportedError';
  }
}

export function isCliSetupTokenSupported(name: CliProviderName): boolean {
  return name === 'claude-code' || name === 'codex';
}

/** Non-REPL auth command that prints an OAuth URL to stdout:
 *  - claude-code: `claude setup-token` — prints URL, expects pasted token on stdin.
 *  - codex: `codex login --device-auth` — prints URL + short device code, polls for approval.
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
    default:
      throw new CliSetupTokenUnsupportedError(provider.name);
  }
}
