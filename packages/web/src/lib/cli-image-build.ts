import { CLI_LOGIN_REFUSAL_CODES } from '@haive/shared/constants';
import type { CliProvider } from './api-client';

export const IMAGE_BUILDING_REASON =
  'Sandbox image is currently rebuilding. Wait for the build to finish, then try again.';
export const IMAGE_FAILED_REASON =
  'The last sandbox image build failed. Fix its cause and rebuild the image before trying again.';
export const IMAGE_BUILD_POLL_MS = 3000;

export type CliImageBuild =
  | { state: 'building'; version: string | null; reason: string }
  | { state: 'failed'; error: string | null; reason: string };

/** The build state is decided by `sandboxImageBuildStatus` alone. `sandboxImageBuildError` outlives
 *  the failure it describes (a ready row can still hold it), so it is display copy inside the failed
 *  view and never what says a build failed. */
export function cliImageBuild(
  p: Pick<CliProvider, 'sandboxImageBuildStatus' | 'sandboxImageBuildError' | 'cliVersion'>,
): CliImageBuild | null {
  if (p.sandboxImageBuildStatus === 'building')
    return { state: 'building', version: p.cliVersion || null, reason: IMAGE_BUILDING_REASON };
  if (p.sandboxImageBuildStatus === 'failed')
    return {
      state: 'failed',
      error: p.sandboxImageBuildError || null,
      reason: IMAGE_FAILED_REASON,
    };
  return null;
}

export function anyImageBuilding(rows: readonly Parameters<typeof cliImageBuild>[0][]): boolean {
  return rows.some((r) => cliImageBuild(r)?.state === 'building');
}

/** The reason the list shows for the image state a login refusal code names. Null for any other
 *  code or none: the login dialog then shows the worker's own message. */
export function loginRefusalReason(code: unknown): string | null {
  if (code === CLI_LOGIN_REFUSAL_CODES.SANDBOX_IMAGE_BUILDING) return IMAGE_BUILDING_REASON;
  if (code === CLI_LOGIN_REFUSAL_CODES.SANDBOX_IMAGE_FAILED) return IMAGE_FAILED_REASON;
  return null;
}
