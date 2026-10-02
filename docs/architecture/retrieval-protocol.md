# Retrieval protocol

`_retrieval-guidance.ts` owns the one block that tells every agent how to find code and
knowledge: DISCOVER with `rag_search`, then GROUND on disk. Grounding runs on HITS as well as
misses and is not a fallback — the index is written by `02-pre-rag-sync` at run start and
`11c-rag-reindex` after the commit gate, so for any file the task itself edited it is not
stale but WRONG, and a DAG coder's siblings work in worktrees it has never seen. That fact is
stated on the `rag_search` bullet of the MCP surface block rather than in the retrieval block,
because it is true of a RUN and agent definition files outlive every run.

It renders against TWO axes, both resolved at DISPATCH and never inferred from prompt wording:
`supportsLsp` (claude-code/zai/ollama/muse/openrouter/grok) and `ragWired` (`adapter.
supportsMcp && surface.rag.enabled` — false for `amp`, and for any repo whose onboarding chose
`ragMode: 'none'`, which is a first-class option and not a fault). Builders always emit the
(LSP, rag) arm; `adaptRetrievalProtocol` rewrites it to the earned cell in ONE pass over a
four-cell table. Not two chained passes: the legacy strings named LSP and `rag_search` in the
same sentence, so each pass would rewrite the other's key out from under it and the second
would then match nothing — silently. Those strings have since been retired into the shared
block (04-phase-0b, 05-phase-0b5), which is what leaves the table with one rag-agnostic entry.

No variant may contain an EMPTY line. Six splice sites join with `.filter(Boolean)` and nine
without, so a blank element renders the same block two ways and the exact-string rewrite finds
only one class of them — half the prompts silently keeping the wrong arm. Asserted in
`_retrieval-guidance.test.ts`.

The rewrite only reaches the canonical block, so ~15 builders that name `rag_search` in their
OWN prose are not covered by it. `mcpSurfacePrompt` carries the backstop: with rag absent it
states so positively and voids any rag instruction from the prompt or from an agent definition
file read off disk. That is why an empty surface — and amp's `null` — is no longer suppressed;
silence there was exactly the dispatch whose body still named the tool.

Grep-first is CORRECT below onboarding step index 14 (`10-rag-populate`): `08-knowledge-
acquisition` (9), `09_5-skill-generation` (11) and `09_5b-skill-repair` (11.5) run before any
index exists. The boundary is that index, not a list of step ids.
