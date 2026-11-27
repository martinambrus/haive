/** Shared by API relinks/repair and worker origin writes. Take before repository rows;
 * never acquire task-creation or domain keys while holding it. PostgreSQL reads a uuid in any
 * letter case, in braces, and with hyphens omitted or after any group of four digits, but prints
 * only the lowercase 8-4-4-4-12 form, so every spelling a route accepts must key that form. */
export function remoteRelinkKey(repositoryId: string): string {
  const hex = repositoryId
    .replace(/^\{(.*)\}$/, '$1')
    .replaceAll('-', '')
    .toLowerCase();
  const id = /^[0-9a-f]{32}$/.test(hex)
    ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    : repositoryId;
  return `remote-relink:${id}`;
}
