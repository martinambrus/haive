/** Shared by API relinks/repair and worker origin writes. Take before repository rows;
 * never acquire task-creation or domain keys while holding it. PostgreSQL matches a uuid in any
 * letter case but prints it lowercase, so a route id spelled otherwise must key the same lock. */
export function remoteRelinkKey(repositoryId: string): string {
  return `remote-relink:${repositoryId.toLowerCase()}`;
}
