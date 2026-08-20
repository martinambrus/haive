# Translator — a resellable Haive module

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
registry, BuildKit-secret token, `entitlementId`) per the 2026-08-20 amendments to
`serialized-chasing-thacker.md` and `rippling-wibbling-puffin.md`. **Executes only after both land.**

## Why it fits Haive better than it looks

The toolkit is file-based (`chunks/` → `translated/`), which appears to need a per-task writable
workspace Haive does not give repo-less tasks — `resolveTaskRepoMount` returns null without a
repository. **Translation needs no workspace at all.** Chunk text goes into the prompt and the
translation comes back in the response, which is what every Haive LLM step already does. Deterministic
work runs in the worker; chunks, glossary and translations live in the module's own database via
`ensure-schema`. `tasks.repositoryId` is already optional at creation (only `onboarding_upgrade`
demands one), so a document-only task is reachable today. **No core changes.**

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
4. **Deterministic drift checks.** After each chunk, string-check that approved glossary terms were
   actually used and that `terms_to_keep` were left alone; flag new capitalised terms absent from the
   glossary. Mechanical, no model judgement, and it catches the drift the prompt merely asks for.

Sequential by design: chunk N+1 needs chunk N's translation. A book translation is a long job and
quality is the point. The **review** pass parallelises (reviews are independent); translation does not.

## Pipeline — task type `translate`

1. **`tr-ingest`** — deterministic, no LLM. Reads the source from a `task_attachments` row (default cap
   25 MiB, admin-tunable via `TASK_ATTACHMENT_MAX_BYTES`), hands it to the toolbox image for
   extraction + repair (`fix_split_words` / `fix_missing_spaces` / `fix_drop_caps`, kept as the
   toolkit's proven Python) and sentence segmentation, then assembles chunks on semantic boundaries in
   TS and stores them with the document structure in the module DB.
2. **`tr-glossary`** — LLM proposes translations for frequency-extracted term candidates and marks
   terms to keep (Sanskrit, Latin, names, ISBN, URLs); then a **form** where the human approves or
   edits. A wrong key term poisons every chunk, so this pause is worth it.
3. **`tr-calibrate`** — translates one representative chunk and derives the **style card**, presented
   in the same form pass for approval. Also the natural place to compare models cheaply before
   committing a whole book to one.
4. **`tr-translate`** — `loop` over chunks, **three real passes per chunk** (accuracy → restructure →
   polish), each a separate invocation seeing the previous output, all carrying glossary + style card
   + rolling tail.
5. **`tr-review`** — independent reviewers read source against translation and emit *specific
   corrections* (not rewrites), which are then applied. This is the translate-edit-proofread model, and
   the reason not to use `purring-marinating-peacock`'s consolidator here: merging three prose
   translations blends three voices, and a book needs one.
6. **`tr-render`** — builds the output document (below).
7. **`tr-deliver`** — output offered for download through the module's `./routes`.

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

Built on first use through the existing `docker-runner.ts` `build()` — the same machinery
env-replicate's `createBuildImageStep` uses — so this needs no new core capability, and the core
worker stays lean.

**The split of responsibilities is the contract.** Orchestration, chunk assembly, glossary logic,
drift checks and prompt building stay in TypeScript in the worker, where they belong. The image does
extraction, segmentation and rendering, exchanging JSON on stdout the way `browser-check.js` already
does. Anything requiring judgement or state stays in TS; the image is a pure function over bytes.

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
