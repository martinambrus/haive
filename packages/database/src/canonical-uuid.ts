/** PostgreSQL reads a uuid in any letter case, in braces, and with hyphens omitted or after any group
 * of four digits, but prints only the lowercase 8-4-4-4-12 form. An advisory key built from the
 * spelling a client sent (a route parameter, a job payload copied from one) takes a different lock
 * than the key built from the database's id of the same row, so two writers each believe they hold
 * the exclusion. Key every uuid-bearing advisory lock on this form. A value that is not a uuid is
 * returned as written. */
export function canonicalUuid(id: string): string {
  const hex = id
    .replace(/^\{(.*)\}$/, '$1')
    .replaceAll('-', '')
    .toLowerCase();
  return /^[0-9a-f]{32}$/.test(hex)
    ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    : id;
}
