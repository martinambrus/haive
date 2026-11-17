/** One shell/Dockerfile operand: a version, dist-tag or simple package name. The bound
 *  covers ordinary pins and semver build metadata. It is a token check, not a registry's
 *  version grammar. Never trim: even trailing newlines must be refused at each boundary. */
export const VERSION_TOKEN_REQUIREMENT =
  'use 1–64 ASCII letters, digits, dots, underscores, pluses or dashes, starting with a letter or digit';

export function isVersionToken(value: unknown): value is string {
  // Avoid `$`, which also matches BEFORE a final newline in JavaScript.
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 64 &&
    /^[A-Za-z0-9]/.test(value) &&
    !/[^A-Za-z0-9._+-]/.test(value)
  );
}

/** Refuse stored or typed data; never rewrite an invalid token into another version. */
export function assertVersionToken(value: unknown, label = 'Version'): asserts value is string {
  if (!isVersionToken(value))
    throw new Error(`${label}: invalid version token; ${VERSION_TOKEN_REQUIREMENT}`);
}
