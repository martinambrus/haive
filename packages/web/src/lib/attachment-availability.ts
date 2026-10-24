import { isReadOnlyLocalRepo } from '@haive/shared/schemas';

// The api refuses an upload into a read-only local repository, so no form may offer one.
export function attachmentUnavailableNote(
  repo: { source: string; writable?: boolean | null } | null | undefined,
): string | null {
  return repo && isReadOnlyLocalRepo(repo)
    ? 'This repository is imported read-only, so files cannot be attached.'
    : null;
}
