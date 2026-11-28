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
