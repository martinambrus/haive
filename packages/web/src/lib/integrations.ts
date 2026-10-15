import { credentialForgeProvider } from '@haive/shared/forge';
import { CORE_INTEGRATION_CATEGORY_SPECS } from '@haive/shared/modularity';

export type ConnectMethod = 'oauth2' | 'device';
export type GithubClientSource = 'env' | 'user' | 'admin' | null;
export type ReconnectReason = 'needs_reauth' | 'write_access';

export interface IntegrationProvider {
  id: string;
  displayName: string;
  categories: string[];
  selfHosted: boolean;
  enabled: boolean;
  writeEnabled: boolean;
  canWrite: boolean;
  writeScopes: Partial<Record<string, string[]>>;
  connect: string[];
}

export interface IntegrationConnection {
  id: string;
  providerId: string;
  accountLabel: string;
  authMethod: string;
  grantedScopes: string[];
  status: string;
  lastError: string | null;
  repoCredentialId: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GitCredentialRow {
  id: string;
  label: string;
  host: string;
  provider?: string | null;
}

export type CompletionBody =
  | { providerId: string; state: string; code: string }
  | { providerId: string; state: string; error: string };

const CONNECT_ORDER: readonly ConnectMethod[] = ['oauth2', 'device'];

export function statusBadge(status: string): {
  label: string;
  variant: 'success' | 'warning' | 'error' | 'default';
} {
  switch (status) {
    case 'connected':
      return { label: 'Connected', variant: 'success' };
    case 'needs_reauth':
      return { label: 'Needs reconnecting', variant: 'warning' };
    case 'provider_unavailable':
      return { label: 'Provider unavailable', variant: 'warning' };
    case 'revoked':
      return { label: 'Revoked', variant: 'error' };
    default:
      return { label: status, variant: 'default' };
  }
}

/** The words behind a failed status. `last_error` outlives the failure, so only the status says whether to show it. */
export function statusNote(
  connection: Pick<IntegrationConnection, 'status' | 'lastError'>,
): string | null {
  if (connection.status === 'connected') return null;
  return connection.lastError?.trim() || null;
}

export function authMethodLabel(method: string): string {
  switch (method) {
    case 'oauth2':
      return 'Web sign-in';
    case 'device':
      return 'Device code';
    case 'token':
      return 'Git credential';
    default:
      return method;
  }
}

export function connectChoices(methods: readonly string[], preferred?: string): ConnectMethod[] {
  const offered = CONNECT_ORDER.filter((kind) => methods.includes(kind));
  const first = offered.find((kind) => kind === preferred);
  return first ? [first, ...offered.filter((kind) => kind !== first)] : offered;
}

export function reconnectMethod(
  connection: Pick<IntegrationConnection, 'authMethod'>,
  methods: readonly string[],
): ConnectMethod | null {
  return connectChoices(methods, connection.authMethod)[0] ?? null;
}

/** Write access was asked for at sign-in only if the switch was on then, so a grant can lack it. */
export function needsWriteReconnect(input: {
  writeEnabled: boolean;
  connection: Pick<IntegrationConnection, 'authMethod' | 'status' | 'grantedScopes'>;
  writeScopes: IntegrationProvider['writeScopes'];
}): boolean {
  const { writeEnabled, connection, writeScopes } = input;
  if (!writeEnabled || connection.status !== 'connected') return false;
  const wanted = writeScopes[connection.authMethod] ?? [];
  return wanted.some((scope) => !connection.grantedScopes.includes(scope));
}

export function reconnectOffer(
  connection: IntegrationConnection,
  provider: IntegrationProvider | undefined,
): { reason: ReconnectReason; method: ConnectMethod | null } | null {
  const method = provider ? reconnectMethod(connection, provider.connect) : null;
  if (connection.status === 'needs_reauth') return { reason: 'needs_reauth', method };
  const upgrade =
    provider !== undefined &&
    needsWriteReconnect({
      writeEnabled: provider.writeEnabled,
      connection,
      writeScopes: provider.writeScopes,
    });
  return upgrade ? { reason: 'write_access', method } : null;
}

export function disconnectNotice(
  connection: Pick<IntegrationConnection, 'accountLabel' | 'repoCredentialId'>,
  providerName: string,
  revoked: 'yes' | 'no' | 'n/a',
): string {
  const done = `${connection.accountLabel} disconnected.`;
  if (connection.repoCredentialId !== null) return `${done} The Git credential stays.`;
  if (revoked === 'yes') return `${done} Its access token was revoked at ${providerName}.`;
  if (revoked === 'no') {
    return `${done} ${providerName} could not be asked to revoke the access token, so remove Haive's access in ${providerName} yourself.`;
  }
  return done;
}

export function canClearGithubClient(source: GithubClientSource): boolean {
  return source === 'user';
}

export function describeGithubClientSource(
  source: GithubClientSource,
): { label: string; text: string } | null {
  switch (source) {
    case 'env':
      return {
        label: 'server environment',
        text: 'The server environment supplies the GitHub OAuth client for everyone, so a client ID saved here is not used while it is set.',
      };
    case 'admin':
      return {
        label: 'administrator',
        text: 'An administrator saved a GitHub OAuth client for everyone. A client ID you save here is used instead of it.',
      };
    case 'user':
      return { label: 'your client ID', text: 'This is the client ID you saved.' };
    default:
      return null;
  }
}

export function linkableCredentials<T extends GitCredentialRow>(
  providerId: string,
  credentials: readonly T[],
  connections: readonly Pick<IntegrationConnection, 'repoCredentialId'>[],
): T[] {
  const taken = new Set(connections.map((connection) => connection.repoCredentialId));
  return credentials.filter(
    (credential) =>
      credentialForgeProvider(credential.provider, credential.host) === providerId &&
      !taken.has(credential.id),
  );
}

/** What the provider sent back to the callback page, as the body `complete` takes; the error description is not forwarded. */
export function completionBody(search: string, providerId: string): CompletionBody | null {
  const params = new URLSearchParams(search);
  const state = params.get('state');
  if (!state) return null;
  const error = params.get('error');
  if (error) return { providerId, state, error };
  const code = params.get('code');
  return code ? { providerId, state, code } : null;
}

export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** A core category's label, else its id: no core spec names a module's category. */
export function categoryLabel(categoryId: string): string {
  return (
    CORE_INTEGRATION_CATEGORY_SPECS.find((spec) => spec.id === categoryId)?.label ?? categoryId
  );
}

export function enabledServing<T extends Pick<IntegrationProvider, 'categories' | 'enabled'>>(
  categoryId: string,
  providers: readonly T[],
): T[] {
  return providers.filter(
    (provider) => provider.enabled && provider.categories.includes(categoryId),
  );
}
