/** Shared retrieval guidance spliced into the workflow prompt builders (discovery,
 *  spec-quality, spec-audit, resolve-warnings, dag-execute, implement, ...).
 *
 *  Reframes retrieval from a FALLBACK CHAIN ("rag_search first, else read KB files,
 *  else grep") to DISCOVER -> GROUND:
 *   - DISCOVER with rag_search — hybrid semantic+lexical search over the repo's
 *     indexed code, its knowledge base, AND the global cross-project KB. The KB is
 *     indexed INTO rag (not a separate channel), so rag_search is the one way in.
 *   - GROUND every lead with LSP + grep TOGETHER, on hits as well as misses — the
 *     index can be stale, so the current file on disk is the source of truth. This
 *     is deliberately NOT a fallback: LSP/grep are used even when rag_search hits.
 *
 *  Centralized here so the ~6 builders that carry this block cannot drift apart.
 *  Returns an array of prompt lines; callers splice it in place of their old
 *  numbered fallback-chain (e.g. after a "How to research" / "Before implementing"
 *  lead-in). Line 1 starts the numbering at 1 so it drops into an existing list. */
export function retrievalGuidanceLines(): string[] {
  return [
    '1. DISCOVER with `rag_search` (the haive-rag tool): hybrid semantic + lexical search over this',
    "   repo's indexed code + knowledge base + the global cross-project KB (house standards,",
    '   version-scoped to this stack). Query the symbols / components / patterns / conventions',
    '   involved — it surfaces WHERE things live and HOW we conventionally do them, tagged',
    '   [local] (this repo) / [global] (house standard) with source paths. Prefer it over blind',
    '   grepping to get oriented.',
    '2. GROUND every lead with LSP + grep TOGETHER — on hits as well as misses, NOT as a fallback.',
    '   The index can be stale, so before you rely on or edit anything, confirm the CURRENT code on',
    '   disk: LSP (when available) for go-to-definition / find-references / hover types, and grep /',
    '   ripgrep for exact usage sweeps. A rag_search snippet is a lead, never the source of truth.',
    '3. On a rag_search miss, go straight to LSP + grep (and read the relevant',
    '   `.claude/knowledge_base/` files directly if rag is unavailable). A miss is an index gap,',
    '   not a reason to stop searching.',
  ];
}
