# Diff viewer

`CommitDiffViewer` reads the existing commit/knowledge diff artifact and compares the old and
current new content in the browser. `commit-diff.ts` builds inline and split rows together,
keeping their line numbers, text highlights and change maps derived from the same comparison.
Editable knowledge files use the fetched live content, so a save updates these views too.

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
whitespace, Unicode and marker grouping. `tests/e2e/tasks/commit-diff.spec.ts` exercises the
real task page with a completed fixture and a mocked artifact: both views, marker navigation,
scroll synchronisation, fullscreen, file switching and narrow-screen containment.
