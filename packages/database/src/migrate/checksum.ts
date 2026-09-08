import { createHash } from 'node:crypto';

/**
 * Normalise a migration's bytes before hashing.
 *
 * NOT raw bytes, which is the instinct. This repo has no `.gitattributes`, so a checkout on a
 * machine with `core.autocrlf=true` rewrites every `.sql` file's line endings — and a raw-byte
 * checksum would then mismatch on all of them at once, hard-failing the install with a message
 * that blames tampering. Stripping the BOM and folding CRLF to LF removes the whole class, and
 * because the same normalisation runs at record time and at check time, a real edit is still
 * caught.
 *
 * Deliberately nothing else: no comment stripping, no whitespace collapsing. The checksum must
 * change when the file changes, and a rewritten comment IS a change to a file whose comments
 * carry the rollback instructions.
 */
export function normalizeForChecksum(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
}

/** sha256 of the normalised text, lowercase hex. */
export function checksum(text: string): string {
  return createHash('sha256').update(normalizeForChecksum(text), 'utf8').digest('hex');
}
