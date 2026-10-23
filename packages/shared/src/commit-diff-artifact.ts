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
}

export interface CommitDiffArtifact {
  headSha: string | null;
  /** Total changed files detected (may exceed files.length when capped). */
  fileCount: number;
  /** File list was capped at MAX_FILES. */
  truncated: boolean;
  files: CommitDiffFile[];
}
