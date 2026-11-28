import { canonicalUuid } from './canonical-uuid.js';

/** Shared by API relinks/repair and worker origin writes. Take before repository rows;
 * never acquire task-creation or domain keys while holding it. */
export function remoteRelinkKey(repositoryId: string): string {
  return `remote-relink:${canonicalUuid(repositoryId)}`;
}
