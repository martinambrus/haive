# Translator — a resellable Haive module

> **Not implemented; reviewed 2026-11-12 against `3426c8c34`.** Module and repo-less task
> foundations ship. The translation protocol, artifact upload/download ownership and checkpoint
> scheme below remain to build; “no core changes” is a goal to verify, not an established result.
> Use the current [Modules](../architecture/modules.md) and [Task types](../architecture/task-types.md)
> contracts rather than the archived modularity plans.

## Context

The user has a working PDF translation toolkit (`translator.zip`): Python extracts and chunks a PDF,
auto-detects terminology, a human completes a glossary, Claude Code translates chunk by chunk under a
"three-pass" prompt, and reportlab rebuilds a PDF. It works, but only Opus at maximum effort produces
publication-quality output.

**That is probably a design artefact, not a model limitation.** `TRANSLATION_PROMPT_TEMPLATE` puts all
three passes — accuracy, grammar restructuring, native polish — into a *single* call and ends with
"Return ONLY the final refined translation, no notes or intermediate steps". Nothing verifies three
passes happened. Holding all three in one turn is hard; weaker models collapse it into pass one.
Splitting them into genuinely separate invocations, each seeing the previous output, is the single
highest-value change here and may bring cheaper models into range.

Ships as `@haive-module/translator`, distributed exactly like the deep-analysis module (private
registry, BuildKit-secret token, `entitlementId`) per the distribution and module-step rules in
`serialized-chasing-thacker.md` and `rippling-wibbling-puffin.md`. **Both foundations have landed.**
It inherits that plan's delivery answer too: a published-image install cannot rebuild api+worker, so
a paying customer receives a per-customer api+worker image the VENDOR builds with this module in
("DECIDED — a published-image install gets PER-CUSTOMER images built by the vendor", 2026-09-07).
Adding a new language capability to module code therefore requires a new vendor channel build
for entitled customers (including web only for compiled web parts), not just a package publish — worth knowing before the two-language split below is treated as free.

## Why it fits Haive better than it looks

The toolkit is file-based (`chunks/` → `translated/`), which appears to need a per-task writable
workspace Haive does not give repo-less tasks — `resolveTaskRepoMount` returns null without a
repository. **The LLM translation calls need no repository workspace.** Chunk text goes into the prompt and the
translation comes back in the response, which is what every Haive LLM step already does. Deterministic
work runs in the worker; chunks, glossary and translations live in the module's own database via
`ensure-schema`. `tasks.repositoryId` is already optional at creation (only `onboarding_upgrade`
demands one), so a document-only task is reachable today. Validate the module seed's
`requiresRepository=false` and its attachment access on that exact create path before promising
no core changes. Deterministic extraction/rendering still needs bounded module-owned scratch
space. No core file-write prompt step can be added to a repo-less type merely to get a directory.

## Consistency across a whole book — the hard part

Chunking is easy; keeping one voice across 300 pages is not. The toolkit carries **terms** across
chunks via `terminology.json` and carries **nothing else**, so chapter 40 reads like a different
translator than chapter 1. Four mechanisms, in order of importance:

1. **Chunk on semantic boundaries, not page counts.** The toolkit's `--pages-per-chunk` routinely
   starts a chunk mid-sentence. Split on paragraph/heading boundaries to a target token size, never
   inside a sentence. This alone removes a large class of seam artefacts.
2. **Style card.** After a calibration chunk, derive a compact record of register, formality (the
   T–V distinction matters enormously in Slavic targets), narrator stance, sentence rhythm and tense
   conventions. Approved by the human alongside the glossary, then injected into *every* chunk prompt.
3. **Rolling tail context.** Each chunk prompt carries the last ~300 words of the **previous
   translated** chunk, so voice continues across the seam. The `loop` hook gives this free:
   `buildIterationPrompt` receives `previousIterations` (`step-definition.ts:339-353`). Take only the
   tail — passing every prior iteration would blow context by chunk 20.
4. **Deterministic drift checks.** After each chunk, check protected placeholders and `terms_to_keep` by stable ids, and flag likely glossary
   drift or new capitalised terms. A literal target-term match cannot prove correctness in an
   inflected language, and a glossary term not present in the source chunk need not appear in its
   translation. Record these as review hints with source/target spans, never automatic meaning
   failures. Completeness checks catch empty/truncated output and missing chunk/paragraph ids,
   not semantic omissions; the independent bilingual review assesses those.

Sequential by design: chunk N+1 needs chunk N's translation. A book translation is a long job and
quality is the point. The **review** pass parallelises (reviews are independent); translation does not.

## Pipeline — task type `translate`

1. **`tr-ingest`** — deterministic, no LLM. Reads the source from a `task_attachments` row (default cap
   25 MiB, admin-tunable via `TASK_ATTACHMENT_MAX_BYTES`), hands it to the toolbox image for
   extraction + repair (`fix_split_words` / `fix_missing_spaces` / `fix_drop_caps`, kept as the
   toolkit's proven Python) and sentence segmentation, then assembles chunks on semantic boundaries in
   TS and stores them with the document structure in the module DB.
2. **`tr-glossary`** — a pre-form LLM phase (`llm.preForm`) proposes translations for frequency-extracted term candidates and marks
   terms to keep (Sanskrit, Latin, names, ISBN, URLs); then a **form** where the human approves or
   edits. A wrong key term poisons every chunk, so this pause is worth it.
3. **`tr-calibrate`** — a pre-form LLM phase translates one representative chunk and derives the **style card**, presented
   in that step's post-generation form for approval. Do not expect a normal form-before-LLM
   phase to display output that has not been generated. Also the natural place to compare models cheaply before
   committing a whole book to one.
4. **`tr-translate`** — a persisted `(documentRevision, chunkId, pass)` cursor, **three real passes per
   chunk** (accuracy → restructure → polish). One loop iteration is one pass, one invocation;
   the iteration after polish advances to the next chunk. Persist each accepted output under a
   unique cursor key before advancing, and read the rolling tail from the preceding chunk's
   accepted polish output, never from an accuracy/restructure draft. The runner's loop limit
   defaults and editable range are too small for a 300-page book: prove a bounded, resumable
   batching scheme (or add an explicitly reviewed long-loop capability) before using `loop`.
   Never issue three model calls hidden inside a single `apply` or bypass CLI dispatch.
5. **`tr-review`** — independent reviewers read source against translation and emit *specific
   corrections* (not rewrites), which are then applied. This is the translate-edit-proofread model, and
   the reason not to use `purring-marinating-peacock`'s consolidator here: merging three prose
   translations blends three voices, and a book needs one.
6. **`tr-render`** — builds the output document (below).
7. **`tr-deliver`** — output offered for download through the module's `./routes`.

**Revision and retry contract.** Ingest hashes the source, extraction/chunker version and document
structure; approval hashes the glossary and style card. Every translation/review row pins those
hashes and invocation id. A changed glossary, style or source invalidates dependent outputs
explicitly; Retry of an unchanged cursor reuses its saved output and does not pay again. A review
correction is a proposed patch keyed by chunk and expected output hash; validate, show/approve
through a form and apply atomically. Corrections at a seam re-check both adjacent chunks. The
original three-pass rationale is a hypothesis; compare quality/cost on the calibration chunk
before recommending a cheaper model, and retain every intermediate output for diagnosis.

Source text, glossary candidates and model drafts are separately bounded/fenced data in prompts,
with Haive's phase/output instructions outside. Preserve paragraph/chunk ids, citation/URL and
markup placeholders and explicit response schemas; never concatenate arbitrary source HTML as
instructions. A single oversized sentence is a named exceptional chunk (or a human-reviewed
split), not an infinite chunking loop. Token budgets reserve space for source, glossary, tail and
output in each provider's actual context window; a 300-word tail is not by itself a budget.

**Artifacts and ownership.** Authorize attachment reads through the owning task/user, use
`fs-safe` from the repository root when a repository exists, and define a worker-owned scratch
anchor for a repo-less document. The API queues extraction/rendering; it never spawns tools.
Module routes authorize every download and ignore user-supplied filesystem paths. Define size,
retention and delete/cancel cleanup for source, intermediate blobs and final outputs; removing a
module keeps data until explicit purge. Module DB references to core tasks have no cross-database
FK: use idempotent cleanup and mark orphaned documents rather than assuming cascade deletion.

## The module's toolbox image — polyglot on purpose

Two jobs here are done materially better outside JavaScript, and the module ships **one image** that
carries both rather than accepting weaker JS equivalents to stay monolingual:

- **PDF text extraction.** `pdfplumber` / PyMuPDF beat `pdfjs-dist` on reading order and layout
  recovery. Bad extraction is where bad translations start — a mis-ordered column or a lost paragraph
  break is unrecoverable downstream. The toolkit's `1_extract_pdf.py`, repair heuristics included,
  therefore **survives as Python** instead of being risk-ported.
- **Sentence segmentation.** The semantic chunker must never split mid-sentence, and naive splitting
  breaks on abbreviations, decimals, quotes and non-English punctuation. `pysbd`/spaCy handle this
  across languages; JS options do not come close.
- **Rendering.** reportlab and pdfkit cannot do bidirectional text or glyph shaping, so the toolkit's
  advertised Arabic target is broken as shipped. Render HTML and print it with **Chromium**, which
  gives RTL bidi, CJK line-breaking and ligatures free because it is a real text-layout engine. The
  worker has neither Chromium nor puppeteer-core (verified), so it ships here.

A worker-owned job builds or pulls a pinned toolbox image, reusing `docker-runner.ts`
`build()` where appropriate. Persist its image identity and serialize builds per tag; a source
module must ship its build context in its published artifacts (not only TypeScript dist).
Validate this packaging and runtime admission before promising no new core capability. The core
worker stays lean.

**The split of responsibilities is the contract.** Orchestration, chunk assembly, glossary logic,
drift checks and prompt building stay in TypeScript in the worker, where they belong. The image does
extraction, segmentation and rendering, exchanging JSON on stdout the way `browser-check.js` already
does. Anything requiring judgement or state stays in TS; the image is a pure function over bytes.

Toolbox jobs run with no network, provider credentials or Docker socket, read-only source and
bounded writable scratch, CPU/RAM/PID/output/time limits; timeout kills and awaits the container.
HTML rendering disables external URL/file loads, scripts and source-controlled CSS fetches, and
resolves assets only from the validated document set. PDF text extraction detects empty/scanned
or bad reading-order input and asks for correction/OCR rather than returning a successful empty
book. OCR is a separate optional feature. EPUB/DOCX extraction uses the existing archive bounds
and held descriptors. Pin image/tool/font versions and verify redistribution licenses, including
the chosen PDF library and fonts, before packaging; PDF reconstruction cannot promise original
pagination or typography. Define an accessible text alternative to the generated PDF.

**Costs, stated:** the image is large (Chromium + Python + fonts, roughly 1–1.5 GB) and built once per
install, and the module becomes two languages with two test stories. Worth it for extraction quality;
not worth it for anything that JS does adequately, which is why nothing else goes in there.

## Formats — phased, because "everything" is where the time goes

Text extraction is where format support actually costs. Ordered by value per unit of work:

- **Slice A:** plain text, markdown, HTML in; markdown + HTML out. Proves the whole pipeline with
  near-zero extraction risk.
- **Slice B:** the toolbox image — PDF in via the toolkit's existing Python extractor (kept, not
  ported) and PDF out via the Chromium renderer, incl. RTL/CJK.
- **Slice C:** epub and docx in (both are zip + XML, so structure survives better than PDF), epub out.

## Defects in the toolkit this fixes

| Toolkit | Here |
| --- | --- |
| Three passes in one prompt, unverified | Three separate invocations, each seeing the last |
| Chunks by page count, splits mid-sentence | Semantic-boundary chunking |
| Glossary carries terms; nothing carries voice | Style card + rolling tail context |
| Term candidates filtered by an **English-only** stopword list | Language-aware candidate filtering |
| Nothing checks a chunk came back complete | Deterministic completeness + glossary-adherence check |
| "Keep `--- PAGE X ---` **or** translate it" — varies per chunk | One rule, decided once, applied by code |
| Arabic offered; reportlab cannot render it | Chromium renderer, RTL verified |

## Model strategy

Per-step CLI preferences already exist, so the expensive model can be pinned to `tr-translate` while
cheaper ones do ingest-adjacent and review work. If `purring-marinating-peacock` Phase 2b lands, the
**review** pass is the right place for multi-model (independent reviewers genuinely disagree usefully);
the translate pass stays single-model to protect voice. Optional, never a prerequisite.

## Verification

**Unit:** the toolbox image's extractor against known-bad PDF text (fixture in, JSON out); semantic chunker never splits mid-sentence and
respects the target size; glossary-adherence check catches a deliberately drifted term; completeness
check catches a truncated chunk; rolling-tail builder takes only the tail regardless of iteration count.

**End to end:** translate a ~20-page English PDF to Slovak — verify diacritics, glossary adherence
across every chunk, and no seam artefacts at chunk boundaries. Repeat to Arabic and confirm RTL renders
correctly (the case the toolkit cannot do). Interrupt mid-book and confirm the loop resumes from the
last completed chunk rather than restarting.

**Adversarial:** a source larger than the attachment cap fails with a clear message, not a truncated
book; a glossary term the model ignores is reported rather than silently accepted; a chunk that returns
empty fails that iteration rather than writing a gap into the output.
