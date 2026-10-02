# Identifier search

**Postgres' text-search PARSER splits snake_case, so a repo's own identifiers were not
searchable as themselves.** MEASURED: `to_tsvector('english','user_has_monter_role')` yields
`user`/`monter`/`role`, `pdf_generator` yields `pdf`/`generat`, and `'simple'` splits
identically — the split happens before any dictionary, so no configuration fixes it. Only
dotted paths (`d_product.inc`) and camelCase (`CNotificationEmail`) survived whole. The
lexical half was therefore matching common English words, which is why `plainto_tsquery`'s
AND of every term matched ZERO rows on 17 of 18 real queries, and why simply switching it to
OR measured WORSE: it promoted `includes/module.inc#module_enable` (dense sim 0.2632) to rank
4 of 12 where every other hit was above 0.65.

**Coverage ranking is the trap to avoid.** Ranking OR-matches by how many query terms a chunk
contains scores better in aggregate (mean dense of added rows 0.509 vs 0.454) but put the
`user_has_monter_role` DEFINITION at rank 137 — a focused function chunk contains few of a
query's terms, so coverage rewards long rambling chunks. Rejected on that measurement.

`identifiers.ts` (`shared/src/rag`) holds ONE extraction rule. `identifierTsvSql` builds the
`update_content_tsv` trigger's SQL and `extractIdentifiers` runs on the query, both from
`IDENTIFIER_PATTERN`, so the index and query sides cannot disagree about what an identifier
is — VERIFIED across 2,000 real chunks and 20,295 lexemes, zero mismatches. Three details are
load-bearing and each cost a measured failure to find:

- **Dotted tokens also emit their SEGMENTS.** The pattern matches greedily, so
  `pdf_generator.class.inc` is one token and the bare `pdf_generator` would never be indexed
  — which alone made the feature miss the case it exists for.
- **The pattern is embedded with SINGLE backslashes.** `standard_conforming_strings` is on, so
  doubling them makes the regex engine read `\\.` as "a literal backslash, then any
  character"; MEASURED, `d_product.inc` then came back as `d_product` + `inc` and the
  whole-path lexeme was never stored.
- **Two camelCase humps, not one.** `[a-z][A-Z]` misses PascalCase with a single-letter prefix
  — `CProduct` and `CPDF` contain no lowercase-then-uppercase pair — so a second clause wants
  an uppercase-then-lowercase pair NOT at the start, which admits `CProduct` while still
  rejecting capitalised prose (`Postgres`, `Excel`) and all-caps words (`PDF`).

Lexemes go in via `array_to_tsvector`, which BYPASSES the parser, and are matched with the
literal-lexeme cast `'pdf_generator'::tsquery` — never `to_tsquery`, which re-runs the parser
and re-splits them (`to_tsquery('simple','pdf_generator')` is `'pdf' <-> 'generator'`). The
`english` prose half is untouched, so no configuration mismatch is introduced. Cost measured
on a 9,197-row store: tsvector total 8.9 MB to 10 MB, 9.3 lexemes added per chunk.

**Ranked by IDF, and that is forced, not preferred.** `array_to_tsvector` stores POSITIONLESS
lexemes and MEASURED `ts_rank_cd` returns exactly 0 for them, so the usual ranker cannot order
identifier matches at all. IDF also fixes flooding: `mpdf` is in 22.8% of chunks and
`pdf_generator` in 0.03%, and an unweighted OR let the common term bury the rare one —
`ln(N/df)` separates them 1.48 vs 8.03 and needs no tuned threshold.

**`identifierCandidates` (3) bounds the INJECTION, and lowering the weight is the wrong knob.**
The ranker is a third RRF input at full weight, but drawing `candidatePool` candidates let it
rewrite the page: MEASURED it displaced `notification_bell.tpl.php` (dense 0.725) from a query
that literally says "notification bell". At HALF weight the motivating case stops surfacing
entirely; at a cap of 3 and full weight it surfaces and displaced top-3 code hits fall from 3
of 18 to 2. An exact identifier match is worth a couple of slots, not the right to rewrite the
ranking — the same bargain the knowledge reserve strikes.

**A query with no identifiers omits the CTE entirely**, so the statement is byte-identical to
the one that shipped before this existed — VERIFIED on the 3 such queries of 18.
`CONFIG_KEYS.RAG_IDENTIFIER_SEARCH_ENABLED` off restores the previous ranking exactly even
against a store that already carries the lexemes, because they are then never queried; that is
the rollback, and no data has to be undone.

**The backfill is not optional, and the reason is not obvious.** `_rag-index.ts` skips a chunk
whose `chunk_hash` is unchanged, and a change to how `content_tsv` is DERIVED leaves `content`
— and the hash — identical, so no existing row is ever re-upserted and the new trigger never
fires on it. `backfillIdentifierTsv` therefore rides `ensureRagSchema` (which runs at the start
of every workflow task via `02-pre-rag-sync`), in the same shape as
`dedupeAndEnforceRepoUniqueness`: warns rather than throws, keeps no applied-record, and
converges structurally — `SET content = content` fires the trigger, which stamps
`IDENTIFIER_TSV_SENTINEL`, and a stamped row never matches the predicate again. MEASURED,
9,197 rows in 17.5s, and the next run is 1.2s writing nothing. The sentinel deliberately
contains no `_`, `.` or hump so `extractIdentifiers` can never emit it from a chunk's own text
— otherwise indexing Haive's own source would stamp a row as upgraded when it was not, and a
version bump would skip exactly those rows. It is capped per invocation so a large store
finishes over the next few syncs rather than making one task wait for the whole rewrite.
