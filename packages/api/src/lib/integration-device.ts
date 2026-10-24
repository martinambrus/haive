import { randomBytes } from 'node:crypto';
import { logger } from '@haive/shared';
import {
  OauthVendorError,
  pollDeviceToken,
  resolveOauthClient,
  resolveOauthClientById,
  startDeviceAuthorization,
  type DevicePollResult,
} from '@haive/shared/integrations';
import type { IntegrationProviderSpec } from '@haive/shared/modularity';
import { HttpError } from '../context.js';
import type { Database } from '../db.js';
import { getRedis } from '../redis.js';
import {
  CLIENT_CHANGED_MESSAGE,
  notConfigured,
  requestedScopes,
  requireDeviceMethod,
  requireEnabled,
  viaVendor,
  vendorFailure,
} from './integration-provider.js';
import { finishSignIn, type SignInResult } from './integration-sign-in.js';
import {
  claimDevicePoll,
  deviceRecordTtl,
  dropDeviceRecord,
  putDeviceRecord,
  slowDevicePoll,
} from './integration-state.js';

const SIGN_IN_GONE_MESSAGE = 'This sign-in is not in progress or has expired. Start again.';

export interface DeviceStart {
  handle: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export type DevicePollOutcome =
  { status: 'pending'; interval: number } | { status: 'ok'; result: SignInResult };

interface DeviceScope {
  db: Database;
  userId: string;
  spec: IntegrationProviderSpec;
  /** The repository forms' GitHub sign-in is not an integration surface, so it skips the admin's switch. */
  checkEnabled: boolean;
}

/** Starts a device sign-in; the browser gets a handle, and the vendor's device code stays on the server. */
export async function startDeviceSignIn(scope: DeviceScope): Promise<DeviceStart> {
  const { db, userId, spec } = scope;
  const method = requireDeviceMethod(spec);
  if (scope.checkEnabled) await requireEnabled(db, spec);
  const client = await resolveOauthClient(db, spec.id, userId, 'device');
  if (!client) throw notConfigured(spec);
  const scopes = await requestedScopes(db, userId, spec, method);
  const authorization = await viaVendor(() =>
    startDeviceAuthorization(fetch, {
      deviceCodeUrl: method.deviceCodeUrl,
      clientId: client.clientId,
      scopes,
    }),
  );
  const handle = randomBytes(32).toString('base64url');
  const expiresIn = deviceRecordTtl(authorization.expiresIn);
  await putDeviceRecord(
    getRedis(),
    userId,
    spec.id,
    handle,
    {
      deviceCode: authorization.deviceCode,
      interval: authorization.interval,
      clientId: client.clientId,
      scopes,
    },
    expiresIn,
    Date.now(),
  );
  return {
    handle,
    userCode: authorization.userCode,
    verificationUri: authorization.verificationUri,
    expiresIn,
    interval: authorization.interval,
  };
}

/**
 * One poll of a device sign-in started by this user. The record is claimed before the vendor is
 * called, so a poll made too early or twice at once never reaches it.
 */
export async function pollDeviceSignIn(
  scope: DeviceScope & { handle: string },
): Promise<DevicePollOutcome> {
  const { db, userId, spec, handle } = scope;
  const redis = getRedis();
  const dropRecord = async () => {
    try {
      await dropDeviceRecord(redis, userId, spec.id, handle);
    } catch {
      // Cleanup must preserve the committed result or the original refusal. The record has a TTL.
      logger.warn({ userId, providerId: spec.id }, 'device sign-in cleanup failed');
    }
  };
  const method = requireDeviceMethod(spec);
  if (scope.checkEnabled) await requireEnabled(db, spec);
  const current = await resolveOauthClient(db, spec.id, userId, 'device');
  if (!current) throw notConfigured(spec);

  const claim = await claimDevicePoll(redis, userId, spec.id, handle, Date.now());
  if (claim.kind === 'unknown') throw new HttpError(400, SIGN_IN_GONE_MESSAGE);
  if (claim.kind === 'early') return { status: 'pending', interval: claim.interval };

  const { record } = claim;
  const client =
    current.clientId === record.clientId
      ? current
      : await resolveOauthClientById(db, spec.id, userId, 'device', record.clientId);
  if (!client) {
    await dropRecord();
    throw new HttpError(400, CLIENT_CHANGED_MESSAGE);
  }

  let polled: DevicePollResult;
  try {
    polled = await pollDeviceToken(fetch, {
      tokenUrl: method.tokenUrl,
      client,
      deviceCode: record.deviceCode,
      interval: record.interval,
    });
  } catch (err) {
    if (err instanceof OauthVendorError) await dropRecord();
    return vendorFailure(err);
  }
  if (polled.status === 'pending') {
    if (polled.interval !== record.interval) {
      await slowDevicePoll(redis, userId, spec.id, handle, polled.interval, Date.now());
    }
    return { status: 'pending', interval: polled.interval };
  }

  try {
    const result = await finishSignIn({
      db,
      userId,
      spec,
      method,
      client,
      tokens: polled.tokens,
      requestedScopes: record.scopes,
    });
    return { status: 'ok', result };
  } finally {
    await dropRecord();
  }
}
