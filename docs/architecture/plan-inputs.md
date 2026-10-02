# Plan inputs

**00-plan-inputs** (index -1, deterministic, no CLI) verifies every attachment row has its
file, refuses a greenfield build with neither a brief nor a file, and writes a readable form
of the kinds no CLI can open — `.docx`/`.xlsx` via `unzip -p` and a small in-repo OOXML reader
(`_plan-inputs.ts`; nothing in the pnpm store parses XML, and OOXML element names are
ISO-29500, so this matches an invariant not someone's formatting), `.pdf` via `pdftotext`.
Sidecars land beside the originals with the api's same chown-to-1000 dance and are indexed by
`_PLAN_INPUTS.md`, which the greenfield prompt names. An extraction that THROWS is reported
per-file and never fails the step — the original is still mounted — while one that yields
nothing is reported as empty, because "unreadable" and "says nothing" are different facts. An
extractor still running after 120 s is killed and reported the same way (`EXTRACT_TIMEOUT_MS`),
since a build's dispatch extracts too, and a hung `pdftotext` there would hold the whole wave.
`02-plan-coverage` reads that normalised set: it used to read the FIRST attachment as UTF-8
regardless of kind, so a PNG arrived as mojibake whose headings were whatever followed a
newline and a hash. Sections carry their `source`, so a gap names its file and two files'
line 12 stay two gaps.

**What a model must SEE is a hard `vision` requirement; a PDF that has text is a soft
preference.** A model with a learned `modelLimits.vision === false` is told by
`NO_VISION_BOUNDARY_PROMPT` not to open images at all, so handing it a wireframe produces a
confident plan that ignored the input. The dispatcher therefore EXCLUDES such a provider when
`vision` is in the capabilities and fails with a message naming what to change; the capability
rides `AgentMiningDispatch.capabilities` rather than the mining spec, because it depends on
the task's inputs and not on the step. `preferVision` is the soft half — it orders known-blind
providers last without excluding any, for an input that has both a visual and a textual form.

The set is `visualOnlyInputs`: images, PLUS any document that needed extraction and yielded no
text. A wireframe PDF is the second case and is why the split is not simply "images" — it is
large because of its pictures, `pdftotext` returns a handful of labels or nothing, and with no
sidecar to fall back on a blind model has nothing at all. That verdict is `ExtractionResult.
hasContent`, decided from the document's own content and NEVER from the rendered markdown:
this module adds a `---` between pages and a `## Sheet` heading per sheet, so `markdown.trim()`
is non-empty for a document that says nothing. MEASURED — a 31 MiB all-picture PDF extracted to
exactly `---`, was recorded as having text, and the requirement that exists to stop a blind
model planning around it did not fire. `PlanInputRow.hasText` carries it structurally beside
`note`, which is display copy nothing branches on.

`DEFAULT_TASK_ATTACHMENT_MAX_BYTES` is 256 MiB for the same reason: the files this feature
exists for are the large ones, and the upload is STREAMED with the cap as a running byte
count, so it bounds disk rather than memory. Raising a default is inert on an install that
already seeded the old one (`seedDefaults` is `setnx`), so `reconcileRaisedDefaults` lifts a
stored value that is still exactly the previous default, on every boot, idempotently — the
deploy path a config-only change would otherwise not have.

**Plan inputs follow the attachments, deletions and additions alike.** `00-plan-inputs` records
the set once, and 01's detect copies what it found into a PERSISTED payload, so a deleted picture
kept demanding `vision`, the index the root prompt reads FIRST kept naming a deleted file, and a
document attached after 00 ran was never extracted at all. `withLiveInputs` (`01-plan-build.ts`)
recomputes those fields at DISPATCH, the root and every wave, through `currentPlanInputs`
(`00-plan-inputs.ts`), and `02-plan-coverage` drafts its gate from the same function and hands
every agent it dispatches the same requirements. A deletion drops the input with every verdict it
carried, and a measured verdict never changes otherwise: a PDF that yielded no text stays
visual-only. An addition is prepared exactly as 00 prepares one (`preparePlanInput`), inside the
same 50-extraction budget, and
the note of an archive expanded since joins it. Preparing can take minutes, and the attachments
notice the dispatch builds afterwards names what is attached THEN, so a pass that prepared anything
reads the rows again and another pass catches up with any that changed, up to three in all.
Membership is by ROW, never by name: a file deleted
and re-uploaded under the same name is a different document, prepared on its own, and never
inherits the verdict of the one it replaced. When anything changed, the index is re-rendered, or
removed once nothing in it is left, and the result is written back over 00's output by
compare-and-set (`WHERE output = <what was read>`), so the next wave neither extracts the same
document again nor loses what it found, while a 00 retry, which resets that output, makes the write
match nothing. That record is also why nothing falls back to the detected fields: after it, a late
picture is a recorded input rather than an addition. A file attached since whose bytes cannot be
read is left unprepared and counts by KIND alone, since the attachments notice names every live
row: a picture requires `vision`, a PDF prefers it. A greenfield root with no brief refuses to
dispatch once nothing at all is attached (`assertSomethingToBuildFrom`), which is 00's own "a brief
or a file" rule re-checked against the live rows, before the inputs are prepared and again after,
since preparing a late document can take minutes and deleting the only one meanwhile must still
refuse. 02's manual repair drops a picked section whose document is gone, by the attachment ROW
the section was read from (`sourceId`): the gate carries the section's BODY, and by name a
same-named replacement recorded since would answer for it. A section's key is its row and line
rather than its name, so a repair of the deleted document does not mark the replacement's section
handled; a repair recorded before sections carried their row cannot say which one it covered and
keeps its name-only meaning. Every lookup fails open, onto the fields the build had before. A failed index REWRITE is
the exception: it drops the index from the prompt, and is recorded that way, since the file on disk
no longer lists what is attached.
