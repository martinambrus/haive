# Translator: books of any size with one glossary and one style (T767)

> Status: approved by the owner 2026-11-26; PR1 in work. Board: T767.
> Evidence: a read-only Codex analysis of the module at c3c988d (kept locally, not in the repository); the file:line references below come from it and drift with the module.

## Context

The owner wants the translator module (`martinambrus/haive-module-translator`, live clone `external-modules/translator`) to translate a book of any size. Parts are fine, but vocabulary, terms and style must stay intact across them. On 2026-11-26 the owner chose one task per book, with batches inside it.

Why it fails today. Each unit is one translation call of whole paragraphs, at most about 1,000 words (`src/chunking/group.ts`). Before any paid call, consent reserves worst-case storage for all `8 × U` translation and review calls up front: about 3.36 MiB per unit, plus a 64 MiB render reserve (`src/protocol/storage.ts` `projectedStorage`). The form caps a document at 512 MiB. Further limits:
- **Up-front reservation:** flat prose stops at about 130 units. A 300,000-word book needs about 1,088 MiB and is refused at consent.
- **Render bound and unit cap:** a 1,000,000-word book is refused earlier, by the 32 MiB-per-file render bound (`src/render/bounds.ts`). It also hits the 1,000-unit cap, which is enforced in SQL checks as indices 0 to 999.
- **Owner reservation:** reservations count against 2 GiB per owner until purge.
- **Glossary:** at most 64 entries (`src/protocol/setup.ts`), a consistency limit in its own right for a long book.

The current way out is to split the file into separate tasks. Each part then gets its own paid glossary and calibration, so terms can drift: exactly what the owner wants to avoid.

The engine already translates one bounded unit per call, carrying the previous unit's polish tail (`src/db/passes.ts`). The limits are admission, whole-book rendering, the term list and the source representation, not the model calls.

## Approach

One task per book, one source admission, one glossary and one approved style.

**Batches.** Translation and review run in batches of units, in global order, still one call per unit and pass.
- The polish tail carries across batch boundaries.
- Review keeps neighbour context and seam invalidation across batches.
- Translate-all-then-review-all stays the phase order.

**Storage.** Reserved per batch, not for the whole book.
- Before each batch, storage for everything that batch can write is reserved under the existing owner advisory lock.
- If it does not fit, the step parks with a named reason and a form to raise the quota. Then the user resumes, with no setup calls repeated and nothing accepted lost.
- The new guarantee: **no paid call starts until its batch's retained writes are reserved; when the next batch cannot fit, the book waits before spending.** Existing results stay available. It replaces "the whole run is reserved at consent".

**Consent.**
- The calibration approval still authorises at most `8 × U` translation and review calls in total.
- A storage grant is a separate, appended record. It never changes the glossary, style or provider hashes, mints calls or reruns setup.
- Old consents keep today's whole-run mode, byte for byte. Only new consents use the batch mode.

**Output.** The output becomes numbered volumes, each Markdown plus HTML within today's 32 MiB per-file and 4 MiB per-part limits, under one book manifest. Publishing volume 2 never deletes volume 1.

**Terms.** A book term catalog replaces the 64-entry cap:
- the whole-book scan stays before approval;
- each unit's prompt carries the terms that occur in it, within today's 8,000-character mandatory budget;
- a term first seen after approval goes to a pending amendment the owner approves, never silently coined per batch.

**Host.** Module-only: no host change and no core table. The quota park uses the existing seams: `prepare` returns false, `completePreForm` stops with `continueRequested: false` before requesting a continuation, the form's `apply` appends the grant, and `ReopenStepFormError` shows Resume. The plan does not use `StepPrepareParkError`, which is reserved for bound singletons (`docs/architecture/modules.md` ~:694-715). The existing review retry-action form (`src/protocol/review-form.ts`) is the pattern.

## PRs (module repo; each shippable alone, xhigh review: consent, money, recovery)

**1. Batch storage mode and the quota wait.**
- Migration `0011`:
  - versioned run policy, separating content/provider authorisation, the approved glossary and style, the paid-call ceiling and resource grants;
  - durable batch holds with settle and release receipts, plus idempotency keys.
- Admission:
  - task `actual + outstanding holds + proposed hold <= document quota`;
  - the same sum over the owner `<=` the owner quota;
  - control-plane headroom kept so a full quota can still record the grant and the operator audit.
- The wait form shows actual, held and required bytes and owner availability, payload-free. This folds in Codex's "diagnostics" PR.
- Named waits: `TRANSLATOR_BATCH_STORAGE_REQUIRED`, `TRANSLATOR_OWNER_STORAGE_REQUIRED`, `TRANSLATOR_DOCUMENT_LIMIT_REQUIRED`.
- Opt-in: only new consents. Batch size is a named constant.
- Rules:
  - holds are released only when provably unused;
  - no time-based expiry for a possibly-paid invocation;
  - Stop and Retry keep bound holds until reconciled.
- Controls:
  - the invariant under two concurrent tasks of one owner;
  - no dispatch on refusal;
  - a grant cannot mint calls or change semantic hashes;
  - stale form, epoch, Retry and Stop;
  - crash after a paid accept uses the reserved bytes;
  - hold settlement after an uncertain enqueue;
  - the real host continuation-to-form path, not only a mocked store;
  - an old-mode consent replays unchanged.

**2. Batched translation and review scheduling.**
- Migration `0012`: batch plans and checkpoints, plus indexes for the next unit and unresolved invocations.
- Code:
  - replace whole-history loads with bounded indexed lookups, since today every session reads all invocations (`src/db/passes.ts` ~:113-148, ~:450-478; `src/db/review.ts` ~:39-71) and would hit the 5 s statement timeout at scale;
  - paginated operator views (today capped at 200, oldest first).
- Controls:
  - batched and unbatched fixtures produce identical accepted hashes;
  - the polish tail crosses a boundary;
  - a correction in a batch's last unit invalidates the next batch's first;
  - every unit is still required before completion;
  - fault cuts at reserve, insert, bind, accept, cursor and grant;
  - the batch id never enters a semantic key.

**3. Volumes.**
- Migration `0013`:
  - book and volume identity, staging, publication receipts, range and coverage hashes;
  - volume-scoped replacement, since today a render deletes every older artifact (`src/db/artifacts.ts` ~:131-136);
  - `bigint` totals.
- Rendering and download:
  - deterministic partition before paid work;
  - lists, quotes and markup reopened across volume boundaries;
  - staged incremental render, with no whole-book string in memory;
  - a paginated volume index;
  - each volume file downloads through the existing verified 32 MiB downloader.
- After PRs 1-3, books up to the 1,000-unit cap (roughly 800,000 to 1,000,000 words) work, given enough quota.
- Controls:
  - full block coverage and deterministic hashes;
  - boundary structure;
  - 4 MiB and 32 MiB limits;
  - a failed replacement keeps the old output;
  - publishing volume 2 keeps volume 1;
  - owner, repository and tombstone scope.

**4. Book term catalog.**
- Migration `0014`: catalog and term revisions, occurrence references, amendment provenance and resumable scan checkpoints.
- Scan and selection:
  - a disk/index-backed whole-book scan, so the 100,000-candidate saturation is disclosed or parked rather than silently truncated;
  - paged approval;
  - per-unit term selection that is Unicode-boundary safe and never drops an applicable required term. If a unit's terms overflow, refuse in preflight with a named remedy.
- Amendments:
  - pending amendments with explicitly consented reconciliation of earlier units;
  - extra paid proposal calls only under added setup consent.
- Controls:
  - a term first occurring late in the book;
  - more than 64 approved terms with bounded prompts;
  - phrase collisions;
  - no silent target or style change;
  - legacy glossary JSON still decodes.

**5. (Parked until a real book needs it) Segmented source above 1,000 units or 25 MiB.**
- Migration `0015`: segmented immutable source rows with the 0-999 SQL checks widened together with the DTOs, and resumable parse. 25 MiB of text is several million words, so PRs 1-4 cover nearly every real book.
- Instead of this PR, consent and ingest name the limit plainly.

**Dropped from the analysis.** Codex's "tighten reserves" PR. Per-batch holds supersede it, its best case gains only 17 units, and under-reservation spends money before failing.

## Decisions

- Owner 2026-11-26: one task per book; batches inside it; terms, vocabulary and style kept across the whole book.
- Mine, to confirm at plan approval:
  - **Default mode.** New consents use batch mode by default. The old whole-run reservation stays available only as the legacy mode for existing consents. A stronger optional "reserve everything up front" mode is not built.
  - **Quota caps.** The document and owner caps stay 512 MiB and 2 GiB until measured. After the owner's first finished paid run (T735), measure actual accounted bytes per unit (counts and sizes only). Raise a cap in PR1 or PR3 only if the measurement shows a 1,000-unit book cannot fit.
  - **Term amendments.** They default to frozen: a new term waits for approval and earlier units are not rewritten without consent.

## Rollback

- Module migrations are roll-forward only: the loader refuses an older binary with fewer receipts (`src/db/migrations.ts` ~:35-42). The undo is a newer release.
- Each PR ships its new admission behind the new-consent mode. Disabling new-mode admission stops new batch-mode tasks. Readers, downloads and a capable worker stay for resumable tasks.
- Legacy consents, receipts and hashes are never rewritten.
- PR3: publishing new volumes can be disabled while old volumes stay downloadable.

## Execution

- `/codex-sonnet`: Codex at high effort drives each PR in a module worktree, created with `git -C external-modules/translator worktree add`. A fresh Sonnet reviews at xhigh.
- Module PRs go through `prwait-repo.sh martinambrus/haive-module-translator` (Codex reviewer only).
- Never format-write the module: it has no prettier config.
- Never run its real-PostgreSQL suite against live data.
- Deploy: fast-forward the live clone, then `pnpm docker libs` while the stack is idle.
  - The live clone carries the owner's uncommitted `src/manifest.ts` change. If a PR touches `src/manifest.ts`, stop and ask the owner before pulling.
- Board: T767 items per PR. The T735 sample run (legacy mode) is unaffected.

## Verification

- Per PR:
  - module unit tests plus its real-PostgreSQL suite (`test:ingest` / `*-db` tests) in a throwaway database;
  - host `check:host`;
  - each control fails on the parent commit first.
- Scale without spend: synthetic flat novels of 300,000 and 1,000,000 words, generated by `randomBytes`-seeded word lists and never real text, driven through the store layer with a fake provider. Prove:
  - batch admission and quota waits;
  - identical hashes to unbatched runs;
  - volume coverage;
  - bounded queries under the 5 s statement timeout.
- Live check after PR3:
  - a 6-unit session-written sample with batch size 2 and a quota set to force one wait;
  - walk the grant form and Resume in the browser, then download two volumes;
  - it costs about 24 subscription calls, so ask the owner before running it.
- After PR4: one sample whose late chapter introduces a new name, to show the pending amendment and its approval.
