/** One shell/Dockerfile operand: a version, dist-tag or simple package name. The bound
 *  covers ordinary pins and semver build metadata. It is a token check, not a registry's
 *  version grammar. Never trim: even trailing newlines must be refused at each boundary. */
export const VERSION_TOKEN_REQUIREMENT =
  'use 1–64 ASCII letters, digits, dots, underscores, pluses or dashes, starting with a letter or digit';

export function isVersionToken(value: unknown): value is string {
  // Check every character explicitly, including trailing line terminators (no multiline anchors).
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
  if (!isVersionToken(value)) {
    const preview =
      typeof value === 'string'
        ? JSON.stringify(value.length > 80 ? `${value.slice(0, 80)}…` : value).replace(
            /[\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g,
            (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
          )
        : typeof value === 'object'
          ? value === null
            ? 'null'
            : '[non-string object]'
          : String(value);
    throw new Error(`${label}: invalid version token ${preview}; ${VERSION_TOKEN_REQUIREMENT}`);
  }
}
