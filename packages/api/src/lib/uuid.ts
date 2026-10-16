/** The canonical text of a uuid of any version: shape only, which is all a Postgres cast checks. */
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_TEXT.test(value);
}

/** Lowercase only: an id that names a container must have one spelling, or an uppercase copy starts a second one. */
export function isCanonicalUuid(value: string): boolean {
  return isUuid(value) && value === value.toLowerCase();
}
