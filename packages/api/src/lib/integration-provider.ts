import { and, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  OauthUnavailableError,
  OauthVendorError,
  getIntegrationProvider,
  isProviderEnabled,
  resolveOauthClient,
} from '@haive/shared/integrations';
import type {
  AuthMethodSpec,
  IntegrationProviderSpec,
  UserInfoSpec,
} from '@haive/shared/modularity';
import { HttpError } from '../context.js';
import type { Database } from '../db.js';

export type Oauth2Method = Extract<AuthMethodSpec, { kind: 'oauth2' }> & {
  userInfo: UserInfoSpec;
};
export type DeviceMethod = Extract<AuthMethodSpec, { kind: 'device' }> & {
  userInfo: UserInfoSpec;
};

export const INVALID_STATE_MESSAGE =
  'This sign-in link is invalid, expired or already used. Start the connection again.';
export const CLIENT_CHANGED_MESSAGE =
  'The OAuth client changed while you were signing in. Start the connection again.';

export function requireProvider(providerId: string): IntegrationProviderSpec {
  const spec = getIntegrationProvider(providerId);
  if (!spec) throw new HttpError(404, 'Unknown integration provider');
  return spec;
}

/** A method with no preregistered client, or no way to identify the account, cannot sign anyone in. */
export function oauth2MethodOf(spec: IntegrationProviderSpec): Oauth2Method | null {
  const method = spec.auth.find(
    (auth): auth is Extract<AuthMethodSpec, { kind: 'oauth2' }> => auth.kind === 'oauth2',
  );
  if (!method?.userInfo || !method.clientRegistration.includes('preregistered')) return null;
  return { ...method, userInfo: method.userInfo };
}

export function deviceMethodOf(spec: IntegrationProviderSpec): DeviceMethod | null {
  const method = spec.auth.find(
    (auth): auth is Extract<AuthMethodSpec, { kind: 'device' }> => auth.kind === 'device',
  );
  return method?.userInfo ? { ...method, userInfo: method.userInfo } : null;
}

export function requireOauth2Method(spec: IntegrationProviderSpec): Oauth2Method {
  const method = oauth2MethodOf(spec);
  if (!method) {
    throw new HttpError(400, `${spec.displayName} cannot be connected with a web sign-in`);
  }
  return method;
}

export function requireDeviceMethod(spec: IntegrationProviderSpec): DeviceMethod {
  const method = deviceMethodOf(spec);
  if (!method) {
    throw new HttpError(400, `${spec.displayName} cannot be connected with a device code`);
  }
  return method;
}

export async function requireEnabled(db: Database, spec: IntegrationProviderSpec): Promise<void> {
  if (!(await isProviderEnabled(db, spec.id))) {
    throw new HttpError(403, `${spec.displayName} is not enabled on this server`);
  }
}

export const notConfigured = (spec: IntegrationProviderSpec) =>
  new HttpError(503, `${spec.displayName} OAuth is not configured on this server`);

/** The sign-in methods a client is configured for, as this user would meet them. */
export async function connectableMethods(
  db: Database,
  userId: string,
  spec: IntegrationProviderSpec,
): Promise<Array<'oauth2' | 'device'>> {
  const methods: Array<'oauth2' | 'device'> = [];
  if (oauth2MethodOf(spec) && (await resolveOauthClient(db, spec.id, userId, 'oauth2'))) {
    methods.push('oauth2');
  }
  if (deviceMethodOf(spec) && (await resolveOauthClient(db, spec.id, userId, 'device'))) {
    methods.push('device');
  }
  return methods;
}

/** Write access is asked for only when the user's switch for the provider is on. */
export async function requestedScopes(
  db: Database,
  userId: string,
  spec: IntegrationProviderSpec,
  method: Oauth2Method | DeviceMethod,
): Promise<string[]> {
  const [setting] = await db
    .select({ writeEnabled: schema.integrationUserSettings.writeEnabled })
    .from(schema.integrationUserSettings)
    .where(
      and(
        eq(schema.integrationUserSettings.userId, userId),
        eq(schema.integrationUserSettings.providerId, spec.id),
      ),
    );
  const scopes = setting?.writeEnabled
    ? [...method.scopes.read, ...method.scopes.write]
    : method.scopes.read;
  return [...new Set(scopes)];
}

export const isForgeProvider = (spec: IntegrationProviderSpec) => spec.categories.includes('forge');

type SignInMethod = Extract<AuthMethodSpec, { kind: 'oauth2' | 'device' }>;

/** The host a sign-in method's own endpoints live on; for a hosted forge that is the Git host. */
export const endpointHost = (method: SignInMethod) =>
  new URL(method.kind === 'device' ? method.deviceCodeUrl : method.authorizeUrl).host;

export function forgeHostOf(spec: IntegrationProviderSpec): string | null {
  const method = spec.auth.find((auth): auth is SignInMethod => auth.kind !== 'token');
  return method ? endpointHost(method) : null;
}

/** The provider's RFC 7009 endpoint, declared on its web method; it revokes a token whichever grant issued it. */
export function revokeUrlOf(spec: IntegrationProviderSpec): string | undefined {
  for (const auth of spec.auth) if (auth.kind === 'oauth2') return auth.revokeUrl;
  return undefined;
}

export function vendorFailure(err: unknown): never {
  if (err instanceof OauthVendorError) {
    throw new HttpError(400, err.description ? `${err.message}: ${err.description}` : err.message);
  }
  if (err instanceof OauthUnavailableError) throw new HttpError(502, err.message);
  throw err;
}

export async function viaVendor<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    return vendorFailure(err);
  }
}
