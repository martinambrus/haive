import { CREDENTIAL_WITHHELD, redactCredentialText } from './credential-scan.js';

export type CommitDiffStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export type CommitDiffLink = 'symlink' | 'gitlink';

export interface CommitDiffFile {
  /** Repo-relative path (the new path for renames). */
  path: string;
  /** Source path, present only for renames. */
  oldPath?: string;
  status: CommitDiffStatus;
  /** Either side is binary; content omitted. */
  binary: boolean;
  /** Either side exceeded the size cap or the total budget; content omitted. */
  truncated: boolean;
  /** A side could not be read: git exited non-zero or the working file could not be opened;
   *  contents are omitted. Absent means both sides were read. */
  unreadable?: boolean;
  /** Optional explanation when the builder can identify why this side is unavailable. */
  unreadableReason?: string;
  /** The new side is a link, not a file; its text is a symlink's target or a submodule's
   *  `Subproject commit <sha>`. Such a file has no `editPath`. */
  link?: CommitDiffLink;
  oldContent: string;
  newContent: string;
  /** Absolute path the web viewer may WRITE this file's new side back to, via
   *  `PUT /tasks/:id/files/content`. Set only by builders whose gate offers
   *  inline editing (the knowledge diff); absent means the file renders
   *  read-only, which is every file of the gate-3 commit diff. Points at the
   *  real worktree file for an on-disk change, and at a `.haive/` staging file
   *  for a draft the step has not written yet — the viewer does not care which,
   *  it just PUTs the path back. */
  editPath?: string;
  /** Display content was withheld; it must never seed a file edit. */
  contentWithheld?: boolean;
}

export interface CommitDiffArtifact {
  headSha: string | null;
  /** Total changed files detected (may exceed files.length when capped). */
  fileCount: number;
  /** File list was capped at MAX_FILES. */
  truncated: boolean;
  files: CommitDiffFile[];
}

/** Shared by every gate builder and the serve-time legacy recheck. A redacted
 * display is read-only: saving it would replace real file bytes with the marker. */
export function redactCommitDiffFile(file: CommitDiffFile): CommitDiffFile {
  const oldContent = redactCredentialText(file.oldContent);
  const newContent = redactCredentialText(file.newContent);
  const withheld =
    file.contentWithheld ||
    oldContent !== file.oldContent ||
    newContent !== file.newContent ||
    oldContent.includes(CREDENTIAL_WITHHELD) ||
    newContent.includes(CREDENTIAL_WITHHELD);
  if (!withheld) return file;
  const { editPath: _editPath, ...readonly } = file;
  return { ...readonly, oldContent, newContent, contentWithheld: true };
}

/** Recheck legacy artifacts at serve time. Invalid/partial JSON never falls back to raw
 * content, which could contain escaped credentials the text scanner cannot recognise. */
export function redactCommitDiffJson(text: string): string {
  try {
    const artifact: unknown = JSON.parse(text);
    if (
      !artifact ||
      typeof artifact !== 'object' ||
      !('files' in artifact) ||
      !Array.isArray(artifact.files)
    )
      return CREDENTIAL_WITHHELD;
    let changed = false;
    for (const [index, file] of artifact.files.entries()) {
      if (!file || typeof file !== 'object') return CREDENTIAL_WITHHELD;
      if (typeof file.oldContent !== 'string' || typeof file.newContent !== 'string')
        return CREDENTIAL_WITHHELD;
      const safe = redactCommitDiffFile(file);
      changed ||= safe !== file;
      artifact.files[index] = safe;
    }
    return changed ? JSON.stringify(artifact) : text;
  } catch {
    return CREDENTIAL_WITHHELD;
  }
}
