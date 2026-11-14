import { scrubErrorPaths } from '@haive/shared/logger';
import { HOST_REPO_ROOT, WORKER_REPO_STORAGE_ROOT } from './worktree-git-boundary.js';

/** Display-only failure text: hide worker storage while keeping container repair paths.
 * Classifiers and fix-loop diagnoses must consume the original safe message instead. */
export function scrubWorkerErrorPaths(err: unknown): string {
  return scrubErrorPaths(err, [WORKER_REPO_STORAGE_ROOT, HOST_REPO_ROOT]);
}
