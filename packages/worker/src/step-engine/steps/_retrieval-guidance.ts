/** Shared retrieval guidance spliced into the workflow prompt builders (discovery,
 *  spec-quality, spec-audit, resolve-warnings, dag-execute, implement, ...).
 *
 *  Reframes retrieval from a FALLBACK CHAIN ("rag_search first, else read KB files,
 *  else grep") to DISCOVER -> GROUND:
 *   - DISCOVER with rag_search — hybrid semantic+lexical search over the repo's
 *     indexed code, its knowledge base, AND the global cross-project KB. The KB is
 *     indexed INTO rag (not a separate channel), so rag_search is the one way in.
 *   - GROUND every lead with the navigation tools the selected CLI can actually
 *     use, plus grep, on hits as well as misses — the index can be stale, so the
 *     current file on disk is the source of truth. This is deliberately NOT a
 *     fallback: grounding happens even when rag_search hits.
 *
 *  Centralized here so the ~6 builders that carry this block cannot drift apart.
 *  Returns an array of prompt lines; callers splice it in place of their old
 *  numbered fallback-chain (e.g. after a "How to research" / "Before implementing"
 *  lead-in). Line 1 starts the numbering at 1 so it drops into an existing list. */
const RETRIEVAL_GUIDANCE_WITH_LSP = [
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
] as const;

// Keep the discovery/grounding protocol intact for CLIs without LSP support;
// only replace the unavailable navigation operations with direct-file evidence.
const RETRIEVAL_GUIDANCE_WITHOUT_LSP = [
  '1. DISCOVER with `rag_search` (the haive-rag tool): hybrid semantic + lexical search over this',
  "   repo's indexed code + knowledge base + the global cross-project KB (house standards,",
  '   version-scoped to this stack). Query the symbols / components / patterns / conventions',
  '   involved — it surfaces WHERE things live and HOW we conventionally do them, tagged',
  '   [local] (this repo) / [global] (house standard) with source paths. Prefer it over blind',
  '   grepping to get oriented.',
  '2. GROUND every lead with grep + direct file reads TOGETHER — on hits as well as misses, NOT as a fallback.',
  '   The index can be stale, so before you rely on or edit anything, confirm the CURRENT code on',
  '   disk: use grep / ripgrep for exact usage sweeps and read the relevant files. A rag_search',
  '   snippet is a lead, never the source of truth.',
  '3. On a rag_search miss, go straight to grep + direct file reads (and read the relevant',
  '   `.claude/knowledge_base/` files directly if rag is unavailable). A miss is an index gap,',
  '   not a reason to stop searching.',
] as const;

// A small number of legacy prompt builders predate the shared block above.
// Keep these exact replacements centralized with it so an unsupported CLI sees
// the same direct-file grounding protocol without losing the surrounding prompt.
const LEGACY_LSP_PROMPT_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  [
    'Then GROUND every lead with LSP + grep against the CURRENT files on disk (on hits too, not as a fallback): the index can be stale, so a rag_search snippet is a lead to confirm, never the source of truth.',
    'Then GROUND every lead with grep + direct file reads against the CURRENT files on disk (on hits too, not as a fallback): the index can be stale, so a rag_search snippet is a lead to confirm, never the source of truth.',
  ],
  [
    'rag_search, then ground with LSP + grep).',
    'rag_search, then ground with grep + direct file reads).',
  ],
  ['(grep -rn / find-references).', '(grep / ripgrep across the whole repository).'],
];

const AGENT_GUIDANCE_START = '[[HAIVE_AGENT_DEFINITION:';
const AGENT_GUIDANCE_END = '[[HAIVE_AGENT_DEFINITION_END]]';
const AGENT_GUIDANCE_PATTERN =
  /\[\[HAIVE_AGENT_DEFINITION:([a-z0-9-]+)\]\]\n([\s\S]*?)\n\[\[HAIVE_AGENT_DEFINITION_END\]\]/g;

export interface PromptCliCapabilities {
  supportsLsp: boolean;
  projectAgentsDir: string | null;
  agentFileFormat: 'markdown' | 'toml' | null;
}

/** Mark a repository-agent instruction so dispatch can either point a capable
 * provider at its native file or remove the external-file dependency for a
 * provider that cannot safely consume old LSP-bearing agent artifacts. */
export function agentDefinitionGuidance(agentId: string, guidance: string): string {
  const expectedPath = `.claude/agents/${agentId}.md`;
  if (!guidance.includes(expectedPath)) {
    throw new Error(`agent guidance for ${agentId} must reference ${expectedPath}`);
  }
  return `${AGENT_GUIDANCE_START}${agentId}]]\n${guidance}\n${AGENT_GUIDANCE_END}`;
}

/** The canonical LSP-capable guidance used by prompt builders. Dispatch adapts
 * it only after choosing the actual CLI provider for an invocation. */
export function retrievalGuidanceLines(): string[] {
  return [...RETRIEVAL_GUIDANCE_WITH_LSP];
}

/** Replace only capability-sensitive grounding text when the resolved CLI
 * cannot expose LSP. Everything else remains byte-for-byte unchanged. */
export function adaptRetrievalGuidanceForLspCapability(
  prompt: string,
  supportsLsp: boolean,
): string {
  if (supportsLsp) return prompt;
  let adapted = prompt.replaceAll(
    RETRIEVAL_GUIDANCE_WITH_LSP.join('\n'),
    RETRIEVAL_GUIDANCE_WITHOUT_LSP.join('\n'),
  );
  for (const [withLsp, withoutLsp] of LEGACY_LSP_PROMPT_REPLACEMENTS) {
    adapted = adapted.replaceAll(withLsp, withoutLsp);
  }
  return adapted;
}

/** Resolve every Haive-owned capability fragment after the actual provider is
 * selected. User/task text is left untouched: only marked agent clauses and
 * exact canonical retrieval fragments are changed. */
export function adaptPromptForCliCapabilities(
  prompt: string,
  capabilities: PromptCliCapabilities,
): string {
  const grounding = adaptRetrievalGuidanceForLspCapability(prompt, capabilities.supportsLsp);
  return grounding.replace(AGENT_GUIDANCE_PATTERN, (_whole, agentId: string, guidance: string) => {
    if (
      !capabilities.supportsLsp ||
      !capabilities.projectAgentsDir ||
      !capabilities.agentFileFormat
    ) {
      return 'Follow the embedded protocol below.';
    }
    const ext = capabilities.agentFileFormat === 'toml' ? 'toml' : 'md';
    return guidance.replace(
      `.claude/agents/${agentId}.md`,
      `${capabilities.projectAgentsDir}/${agentId}.${ext}`,
    );
  });
}

/** One rule for implementation agents that may author `.ddev/config.yaml`.
 *
 *  Agents add `ddev_version_constraint` unprompted — pinning is ordinary DDEV practice — and
 *  some write an EXACT version, which is dead the moment the runner's DDEV differs by a patch.
 *  Observed across six add-ddev tasks: four wrote ranges, two wrote exact pins and both tasks
 *  died at `ddev start`. The runner repairs an exact pin at boot (ddev-version-constraint.ts),
 *  so this is the cheap nudge that stops it being written, not the thing that saves the task.
 *
 *  Gated on the work actually mentioning DDEV so a repo that has nothing to do with it never
 *  pays for the lines. The match is a heuristic, not a contract: a miss costs the nudge, never
 *  correctness — the runtime repair still catches it. */
export function ddevConfigGuidanceLines(context: string): string[] {
  if (!/\bddev\b/i.test(context)) return [];
  return [
    '',
    'If you create or edit .ddev/config.yaml: do NOT pin `ddev_version_constraint` to an exact',
    'version (e.g. `v1.25.2`). The DDEV that runs this project is not necessarily the one you',
    'see documented, and an exact pin fails the moment it differs by a patch. Use a range such',
    'as ">= v1.24.0 < v2.0.0", or leave the key out entirely.',
  ];
}
