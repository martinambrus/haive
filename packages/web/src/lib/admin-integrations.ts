export type IntegrationAuthKind = 'oauth2' | 'device' | 'token';

export interface AdminIntegrationProvider {
  id: string;
  name: string;
  categories: string[];
  authKinds: IntegrationAuthKind[];
  enabled: boolean;
  rowExists: boolean;
  oauthClientId: string | null;
  hasClientSecret: boolean;
  redirectUri: string;
  precedence: { envVar: string; envSet: boolean } | null;
}

export interface AdminIntegrationUpdate {
  enabled?: boolean;
  oauthClientId?: string;
  oauthClientSecret?: string;
}

/** The PUT body for the client fields: only what changed. A blank secret box keeps the saved secret. */
export function clientUpdate(
  provider: AdminIntegrationProvider,
  draft: { clientId: string; secret: string },
): AdminIntegrationUpdate | null {
  const update: AdminIntegrationUpdate = {};
  const clientId = draft.clientId.trim();
  if (clientId !== (provider.oauthClientId ?? '')) update.oauthClientId = clientId;
  const secret = draft.secret.trim();
  if (secret !== '') update.oauthClientSecret = secret;
  return Object.keys(update).length > 0 ? update : null;
}

/** Only an OAuth or device sign-in reads a client; a token-only provider has nothing to configure here. */
export function usesOauthClient(provider: Pick<AdminIntegrationProvider, 'authKinds'>): boolean {
  return provider.authKinds.some((kind) => kind === 'oauth2' || kind === 'device');
}

export function secretPlaceholder(hasClientSecret: boolean): string {
  return hasClientSecret ? 'saved — enter a new value to replace' : 'not set';
}

export function precedenceNote(
  precedence: AdminIntegrationProvider['precedence'],
): { tone: 'warning' | 'info'; text: string } | null {
  if (!precedence) return null;
  if (precedence.envSet) {
    return {
      tone: 'warning',
      text: `${precedence.envVar} is set in the environment, so the environment variable wins: it overrides the client saved here and any client ID a user saved for themselves.`,
    };
  }
  return {
    tone: 'info',
    text: `Order of precedence: the ${precedence.envVar} environment variable (not set), then a client ID a user saved for themselves, then the client saved here.`,
  };
}

export function enabledLabel(provider: AdminIntegrationProvider): string {
  const state = provider.enabled ? 'Enabled' : 'Disabled';
  return provider.rowExists ? state : `${state} by default`;
}
