const MIB = 1024 * 1024;

/** What a reader of the record's directory accepts: entries counted as files plus directories. */
export const PROJECT_STATE_LIMITS = {
  maxEntries: 4096,
  maxFileBytes: MIB,
  maxTotalBytes: 16 * MIB,
} as const;

/** The most the repository's AGENTS.md rules override may hold once normalised, in UTF-8 bytes. The
 *  setting's own cap, not one a reader of the directory enforces, so it is no entry above. */
export const MAX_AGENT_RULES_BYTES = 64 * 1024;

export type RecordReadable = { readable: true } | { readable: false; reason: string };

/** Whether a reader's walk of these files (relative to the state directory) would accept them. */
export function recordReadable(files: ReadonlyMap<string, string>): RecordReadable {
  const dirs = new Set<string>();
  const utf8 = new TextEncoder();
  let bytes = 0;
  for (const [rel, text] of files) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    const size = utf8.encode(text).length;
    if (size > PROJECT_STATE_LIMITS.maxFileBytes) {
      return {
        readable: false,
        reason: `${rel} is larger than ${PROJECT_STATE_LIMITS.maxFileBytes / MIB} MiB`,
      };
    }
    bytes += size;
  }
  if (files.size + dirs.size > PROJECT_STATE_LIMITS.maxEntries) {
    return {
      readable: false,
      reason: `the state directory would hold more than ${PROJECT_STATE_LIMITS.maxEntries} entries`,
    };
  }
  if (bytes > PROJECT_STATE_LIMITS.maxTotalBytes) {
    return {
      readable: false,
      reason: `the state directory would hold more than ${PROJECT_STATE_LIMITS.maxTotalBytes / MIB} MiB`,
    };
  }
  return { readable: true };
}
