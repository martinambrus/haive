import { describe, expect, it } from 'vitest';
import { CLI_LOGIN_REFUSAL_CODES } from '@haive/shared/constants';
import {
  IMAGE_BUILDING_REASON,
  IMAGE_BUILD_POLL_MS,
  IMAGE_FAILED_REASON,
  anyImageBuilding,
  cliImageBuild,
  loginRefusalReason,
} from './cli-image-build';

const row = (
  status: 'idle' | 'building' | 'ready' | 'failed',
  error: string | null = null,
  cliVersion: string | null = null,
) => ({ sandboxImageBuildStatus: status, sandboxImageBuildError: error, cliVersion });

describe('cliImageBuild', () => {
  it('L1 reports a building row with and without a version', () => {
    expect(cliImageBuild(row('building', null, '2.0'))).toEqual({
      state: 'building',
      version: '2.0',
      reason: IMAGE_BUILDING_REASON,
    });
    expect(cliImageBuild(row('building'))).toEqual({
      state: 'building',
      version: null,
      reason: IMAGE_BUILDING_REASON,
    });
  });

  it('L2 reports a failed row with its error text, or null', () => {
    expect(cliImageBuild(row('failed', 'docker said no'))).toEqual({
      state: 'failed',
      error: 'docker said no',
      reason: IMAGE_FAILED_REASON,
    });
    expect(cliImageBuild(row('failed'))).toEqual({
      state: 'failed',
      error: null,
      reason: IMAGE_FAILED_REASON,
    });
  });

  it('L3 decides by status alone: stale error text never shows on ready or idle rows', () => {
    expect(cliImageBuild(row('ready', 'old failure'))).toBeNull();
    expect(cliImageBuild(row('idle', 'old failure'))).toBeNull();
    expect(cliImageBuild(row('building', 'old failure', '1.0'))).toEqual({
      state: 'building',
      version: '1.0',
      reason: IMAGE_BUILDING_REASON,
    });
  });

  it('L4 polls every three seconds', () => {
    expect(IMAGE_BUILD_POLL_MS).toBe(3000);
  });

  it('L5 anyImageBuilding is true only when some row is building', () => {
    expect(anyImageBuilding([])).toBe(false);
    expect(anyImageBuilding([row('ready'), row('idle'), row('failed', 'x')])).toBe(false);
    expect(anyImageBuilding([row('ready'), row('building'), row('failed')])).toBe(true);
  });
});

describe('loginRefusalReason', () => {
  it('L6 gives each image refusal code the reason the list shows for that state', () => {
    expect(loginRefusalReason(CLI_LOGIN_REFUSAL_CODES.SANDBOX_IMAGE_BUILDING)).toBe(
      cliImageBuild(row('building'))?.reason,
    );
    expect(loginRefusalReason(CLI_LOGIN_REFUSAL_CODES.SANDBOX_IMAGE_FAILED)).toBe(
      cliImageBuild(row('failed'))?.reason,
    );
  });

  it('L7 says nothing for a missing or unknown code, so the message is kept', () => {
    expect(loginRefusalReason(undefined)).toBeNull();
    expect(loginRefusalReason('something_new')).toBeNull();
    expect(loginRefusalReason(4409)).toBeNull();
  });
});
