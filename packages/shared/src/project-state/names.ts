import { createHash } from 'node:crypto';

// Keeps a file name inside the 255-byte limit of common filesystems; the hash keeps it unique.
const SLUG_MAX_BYTES = 180;

const NAME = /^[a-z0-9][a-z0-9-]*$/;

const shortHash = (key: string): string =>
  createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 8);

function boundedSlug(slug: string): string {
  if (Buffer.byteLength(slug) <= SLUG_MAX_BYTES) return slug;
  let out = '';
  for (const ch of slug) {
    if (Buffer.byteLength(out + ch) > SLUG_MAX_BYTES) break;
    out += ch;
  }
  return out;
}

/** A setting or CLI name the record can hold as a file name. */
export const isRecordName = (name: string): boolean => NAME.test(name);

/** A repository path a claim may name: relative, canonical, and free of `..` and control
 *  characters. */
export function isClaimablePath(path: string): boolean {
  if (path === '' || /[\u0000-\u001f\u007f\\]/.test(path)) return false;
  return path.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** Flat on purpose, and with no leading dot: a tree mirroring `.claude/...` under `.haive-data`
 *  would plant directories the CLIs scan. */
export function claimFileName(diskPath: string): string {
  const slug = diskPath
    .split('/')
    .map((seg) => seg.replace(/^\.+/, ''))
    .join('__');
  return `artifacts/${boundedSlug(slug)}~${shortHash(diskPath)}.json`;
}

export function bundleFileName(source: string): string {
  const slug = source.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '');
  return `bundles/${boundedSlug(slug)}~${shortHash(source)}.json`;
}
