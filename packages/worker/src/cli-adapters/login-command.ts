import type { CliCommandSpec, CliProviderName, CliProviderRecord } from './types.js';

export class CliLoginUnsupportedError extends Error {
  readonly code = 'cli_login_unsupported';
  constructor(providerName: CliProviderName) {
    super(`interactive login not implemented for provider ${providerName}`);
    this.name = 'CliLoginUnsupportedError';
  }
}

export interface CliLoginInstructions {
  /** Short banner shown above the terminal modal. */
  headline: string;
  /** Ordered step hints rendered as a list. */
  steps: string[];
}

export function isCliLoginSupported(name: CliProviderName): boolean {
  return name === 'claude-code' || name === 'codex';
}

export function buildLoginCommand(provider: CliProviderRecord, executable: string): CliCommandSpec {
  const env = provider.envVars ?? {};
  switch (provider.name) {
    case 'claude-code':
      return { command: executable, args: [], env };
    case 'codex':
      return { command: executable, args: ['login'], env };
    default:
      throw new CliLoginUnsupportedError(provider.name);
  }
}

export function getLoginInstructions(name: CliProviderName): CliLoginInstructions {
  switch (name) {
    case 'claude-code':
      return {
        headline: 'Sign in to Claude Code',
        steps: [
          'Type /login in the terminal and press Enter.',
          'Open the URL printed below in your browser and complete the sign-in.',
          'Copy the authorization code Anthropic shows you and paste it back into the terminal.',
          'Wait for "Login successful" then click "Finish login".',
        ],
      };
    case 'codex':
      return {
        headline: 'Sign in to OpenAI Codex',
        steps: [
          'Follow the on-screen prompts. Codex prints a sign-in URL and a one-time code.',
          'Open the URL in your browser and paste the code when asked.',
          'Return here when the terminal confirms the session is authenticated.',
          'Click "Finish login" to persist and re-test.',
        ],
      };
    default:
      return {
        headline: 'Interactive login not supported',
        steps: ['This CLI provider has no interactive login flow in haive yet.'],
      };
  }
}
