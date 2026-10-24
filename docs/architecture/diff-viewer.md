# Diff viewer

`CommitDiffViewer` reads the existing commit/knowledge diff artifact and compares the old and
current new content in the browser. `commit-diff.ts` builds inline and split rows together,
keeping their line numbers, text highlights and change maps derived from the same comparison.
Editable knowledge files use the fetched live content, so a save updates these views too.

Both artifact builders, `_commit-diff.ts` for gate 3 and `_knowledge-diff.ts` for the knowledge
gates, list each changed file on its own, files inside a new untracked directory included, and
stop at `MAX_FILES` (500). `fileCount` counts every changed file, listed or not, and `truncated`
says the list was cut; the viewer shows that count and a "list truncated" mark.

An empty list means git listed no changes, never that git failed. When `git status` exits
non-zero, both builders delete their earlier artifact and throw. Every caller catches the
builder's throw: gate 3, the KB commit and run-app leave the artifact path unset and hide the
viewer, while the learning and external-KB gates keep the path predicted in detect, so the
viewer reports "Could not load changes" instead of a stale diff or "No changes to show". Gate 3
and the KB commit also run their own `git status` in detect, outside that catch, so a status that
keeps failing fails those steps there before any diff is built.

A file that could not be read is not an empty file. `buildFileEntry` sets `unreadable` on its
entry when `git ls-tree -l HEAD -- <path>` exits non-zero or lists no blob or submodule there,
when `git show HEAD:<path>` exits non-zero, or when the working file cannot be opened (a FIFO, a
file that vanished, a permission error), and it drops both contents, as it does for a binary or
oversized file. It keys on git's exit code and record layout, never on its message. Left empty,
the side that did read would diff against nothing: a modified file would render as all-added or
all-removed and a deleted file as an empty deletion. The viewer shows the entry's
`unreadableReason` when it has one, else "Could not read this file", instead of a diff; the reason
is display copy, the flag decides. Gate 3 gives the commit-message generator the path and status only ("content
unavailable"), and the knowledge builders set no `editPath`, so the file cannot be edited. The
field is absent when both sides were read, which covers every artifact an older worker wrote and
every learning entry the learning step synthesizes. Its investigation entry is read from the path
it will be written to with a strict read, capped and NUL-checked by the same reader as
`buildFileEntry` (a binary or oversized file keeps no contents and no `editPath`): nothing there,
or no directory yet, is a new file, an existing empty file is a modified one with an empty old
side, and a link, a pipe or a refused read flags the entry the same way.

A link is not an unreadable file. A symlink reads as its target text: the old side is the blob git
holds, the new side is `readLinkNoFollow` on the working path, which reads the link without
following it. A submodule reads as `Subproject commit <sha>` on each side, the text `git diff`
prints for one. The old sha comes from the tree entry `ls-tree -l` lists (mode 160000), asked
before any blob is read, so a commit that also sits in the superproject's object store is not
shown as a patch. The new sha is the index entry or, when git reports the checkout as moved on
disk (`Y` is `M`) or as an intent to add (`Y` is `A`, whose index entry is the empty blob), the
sha `git --git-dir=.git rev-parse --verify --quiet HEAD` resolves inside the checkout. That reads
the ref and never the commit object, as `git add` does (`resolve_gitlink_ref`), and it is asked
only when the held directory has a `.git` directory or file of its own. That directory is opened without
following links and handed to git as a descriptor, so a name swapped after the check cannot
redirect it, and an uninitialised submodule, an empty directory where git answers with the
superproject's own HEAD, is never asked. Paths reach git as `:(literal)` pathspecs. Such an entry
sets `link` (`symlink` or `gitlink`) for its new side: the viewer names it with a badge, gate 3
passes it to the commit-message generator beside the target text, and the knowledge builders set
no `editPath`, since the text is a target, not a file's bytes. A submodule whose own working tree
is dirty but whose commit has not moved reads as no change, because the commit would not record
the rest. A repository nobody added as a submodule (git lists it as `dir/`) is shown as
`git add -A` records it: a gitlink at its checked-out commit or, while its HEAD is unborn (exit 1),
an unreadable entry whose reason says git cannot stage it. A git run that gave no answer, a
conflicted gitlink, a gitlink path that now holds a pipe and a symlinked `.git` stay unreadable
with no reason. `CommitDiffFile` and
`CommitDiffArtifact` are declared once, in `@haive/shared/commit-diff-artifact`, and the builders
and the viewer both import them; a new field goes there.

Whole lines retain their red/green background. A removed run followed by an added run also
gets a `diffWordsWithSpace` comparison: only changed words, punctuation and whitespace receive
the brighter background. Compare the entire replacement run before projecting spans onto
its original lines; comparing arbitrary line pairs would highlight unchanged text when an
inserted comment shifts the neighbouring lines. Preserve the original text and whitespace.
The existing split layout still pairs removed/added lines by position. Text highlighting
skips runs over 100,000 characters or word comparisons exceeding 1,000 edits; whole-line
colours and the map remain available without the supplementary spans.

The change map lives beside the scrolling panes, so it stays visible at every scroll position
and in fullscreen. Marker positions use displayed rows (including inline removals and empty
split cells), not just new-file line numbers. Adjacent changed rows become one marker per
colour; separate red/green lanes keep both sides of a replacement visible. A minimum height
of three pixels keeps single-line edits visible even in long files. Buttons expose the old
or new line range through their tooltip and accessible name, and support keyboard activation.
Activating one centres its first row within the diff pane while preserving horizontal scroll.
In split mode both panes move together. Selecting another file remounts the panes and resets
their scroll position.

`commit-diff.test.ts` covers span reconstruction, uncommented settings, shifted comments,
whitespace, Unicode and marker grouping. `commit-diff-viewer.test.tsx` draws the viewer through
the DOM-less test renderer for the unreadable and link states. `tests/e2e/tasks/commit-diff.spec.ts`
exercises the real task page with a completed fixture and a mocked artifact: both views, marker
navigation, scroll synchronisation, fullscreen, file switching and narrow-screen containment.
