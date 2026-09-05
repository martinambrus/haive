import { KB_DIR } from '@haive/shared/knowledge-paths';

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
 *  Centralized here so the builders that carry this block cannot drift apart.
 *  Returns an array of prompt lines; callers splice it in place of their old
 *  numbered fallback-chain (e.g. after a "How to research" / "Before implementing"
 *  lead-in). Line 1 starts the numbering at 1 so it drops into an existing list.
 *
 *  Rendered against TWO axes, both resolved at dispatch (see `RetrievalAxes`). Builders
 *  always emit the (LSP, rag) arm below and `adaptRetrievalProtocol` rewrites it to the
 *  cell the provider and surface actually earn. NO variant may contain an empty line:
 *  six splice sites join with `.filter(Boolean)` and nine without, so a blank element
 *  would render the same block two ways and the exact-string rewrite would find only
 *  one of them. `_retrieval-guidance.test.ts` asserts that.
 *
 *  The DEFERRED-tool note is phrased as a condition ("may be"), not resolved at dispatch on a
 *  third axis. It is true of the claude BINARY rather than of a provider — claude-code, zai,
 *  ollama, muse and openrouter all run it — and a fourth cell per axis would double the table
 *  the exact-string rewrite walks. MEASURED on claude-code 2.1.261 across four sandbox probes:
 *  the eager tool set is a fixed 11 and `deferred = listed - 11` whatever the MCP config, so
 *  `rag_search` is deferred even as the ONLY server. On one real plan-build fan-out that cost
 *  the tool 7 of 13 agents, which each then ran 7-19 shell greps instead. `ENABLE_TOOL_SEARCH=0`
 *  removes the hop and was rejected: MEASURED ~15k extra prompt tokens per agent with rag as the
 *  only server (32.0k against 16.5k), and it is an undocumented vendor env.
 *
 *  The text-search line names no tool for the same reason: a Grep tool exists on some CLIs and
 *  not others (claude-code 2.1.261 announces neither Grep nor Glob), and the block must not send
 *  an agent at a tool its run does not have — nor push one that HAS the tool into the shell. */
const RETRIEVAL_GUIDANCE_WITH_LSP = [
  '1. DISCOVER with `rag_search` (the haive-rag tool): hybrid semantic + lexical search over this',
  "   repo's indexed code + knowledge base + the global cross-project KB (house standards,",
  '   version-scoped to this stack). Query the symbols / components / patterns / conventions',
  '   involved — it surfaces WHERE things live and HOW we conventionally do them, tagged',
  '   [local] (this repo) / [global] (house standard) with source paths. Prefer it over blind',
  '   grepping to get oriented.',
  '   `rag_search` may be a DEFERRED tool here — its NAME is announced but its schema is not',
  '   loaded. If so, spend the one `ToolSearch` (`select:mcp__haive-rag__rag_search`) and use it;',
  '   that hop is not a reason to fall back to text search.',
  '2. GROUND every lead with LSP + grep TOGETHER — on hits as well as misses, NOT as a fallback.',
  '   The index can be stale, so before you rely on or edit anything, confirm the CURRENT code on',
  '   disk: LSP (when available) for go-to-definition / find-references / hover types, and grep /',
  '   ripgrep for exact usage sweeps. A rag_search snippet is a lead, never the source of truth.',
  '   Text search means a Grep tool where the run has one, else `grep` / `rg` through the shell.',
  '3. On a rag_search miss, go straight to LSP + grep (and read the relevant',
  `   \`${KB_DIR}/\` files directly if rag is unavailable). A miss is an index gap,`,
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
  '   `rag_search` may be a DEFERRED tool here — its NAME is announced but its schema is not',
  '   loaded. If so, spend the one `ToolSearch` (`select:mcp__haive-rag__rag_search`) and use it;',
  '   that hop is not a reason to fall back to text search.',
  '2. GROUND every lead with grep + direct file reads TOGETHER — on hits as well as misses, NOT as a fallback.',
  '   The index can be stale, so before you rely on or edit anything, confirm the CURRENT code on',
  '   disk: use grep / ripgrep for exact usage sweeps and read the relevant files. A rag_search',
  '   snippet is a lead, never the source of truth.',
  '   Text search means a Grep tool where the run has one, else `grep` / `rg` through the shell.',
  '3. On a rag_search miss, go straight to grep + direct file reads (and read the relevant',
  `   \`${KB_DIR}/\` files directly if rag is unavailable). A miss is an index gap,`,
  '   not a reason to stop searching.',
] as const;

// The rag-off arms. `rag_search` is not merely unhelpful when the repo has no index
// (`ragMode: 'none'`) or the CLI hosts no MCP servers (amp) — naming it sends the agent
// at a tool that does not answer. Text search becomes the discovery step rather than the
// grounding step, so this is a reordering, not the old fallback chain returning.
function retrievalGuidanceWithoutRag(supportsLsp: boolean): string[] {
  return [
    `1. LOCATE with ${supportsLsp ? 'LSP + grep' : 'grep / ripgrep'}: no semantic index is wired for this run, so text`,
    '   search IS the discovery step. Start from the symbols / components / conventions the task',
    supportsLsp
      ? '   names, use LSP for go-to-definition / find-references / hover types, and widen from the hits.'
      : '   names and widen from the hits.',
    '   Text search means a Grep tool where the run has one, else `grep` / `rg` through the shell.',
    '2. GROUND every lead against the CURRENT code on disk — open the files the search returned;',
    '   never work from a name alone.',
    `3. Read \`${KB_DIR}/\` directly for the project's documented conventions. It is a set of files`,
    '   in this repo, so grep reaches it.',
  ];
}

/** Every rendering of the protocol, indexed by `variantIndex`. The canonical
 *  (LSP, rag) form at index 0 is what every prompt builder emits; dispatch rewrites it
 *  to the cell the resolved provider and surface actually earn. */
function retrievalVariants(): [string[], string[], string[], string[]] {
  return [
    [...RETRIEVAL_GUIDANCE_WITH_LSP],
    retrievalGuidanceWithoutRag(true),
    [...RETRIEVAL_GUIDANCE_WITHOUT_LSP],
    retrievalGuidanceWithoutRag(false),
  ];
}

function variantIndex({ supportsLsp, ragWired }: RetrievalAxes): 0 | 1 | 2 | 3 {
  return ((supportsLsp ? 0 : 2) + (ragWired ? 0 : 1)) as 0 | 1 | 2 | 3;
}

// One table, one pass, four cells per entry — NOT two chained replacements. The legacy
// strings that named both LSP and rag_search have been retired into the shared block
// (04-phase-0b-pre-planning, 05-phase-0b5-spec-quality), which is what makes a single
// axis enough here: chaining an LSP pass and a rag pass would have had each rewrite the
// other's key out from under it, and the second pass would then silently match nothing.
const PROMPT_VARIANT_TABLE: ReadonlyArray<
  readonly [source: string, variants: readonly [string, string, string, string]]
> = [
  [
    '(grep -rn / find-references).',
    [
      '(grep -rn / find-references).',
      '(grep -rn / find-references).',
      '(grep / ripgrep across the whole repository).',
      '(grep / ripgrep across the whole repository).',
    ],
  ],
];

const AGENT_GUIDANCE_START = '[[HAIVE_AGENT_DEFINITION:';
const AGENT_GUIDANCE_END = '[[HAIVE_AGENT_DEFINITION_END]]';
const AGENT_GUIDANCE_PATTERN =
  /\[\[HAIVE_AGENT_DEFINITION:([a-z0-9-]+)\]\]\n([\s\S]*?)\n\[\[HAIVE_AGENT_DEFINITION_END\]\]/g;

/** The two axes the protocol renders against. Both are resolved at DISPATCH: the LSP one
 *  from the adapter plus a ready bridge, the rag one from the adapter's MCP support plus
 *  the task's resolved surface. */
export interface RetrievalAxes {
  supportsLsp: boolean;
  ragWired: boolean;
}

/** Everything dispatch resolves before adapting a prompt. `supportsLsp`,
 *  `projectAgentsDir` and `agentFileFormat` are provider properties; `ragWired` is a
 *  provider AND task property, since a CLI that hosts MCP servers still gets no rag on a
 *  repo that skipped the index. */
export interface PromptCliCapabilities extends RetrievalAxes {
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
  return retrievalGuidanceLinesFor(true);
}

/** Variant chosen at RENDER time, for callers that already know the target's LSP
 * capability because they write a file rather than dispatch a prompt (the agent
 * file writers). Those files outlive any one task and cannot know a future run's rag
 * mode, so they render the rag-on arm; the surface block contradicts them at dispatch
 * when the tool is absent. Prompt builders keep using retrievalGuidanceLines() plus the
 * dispatch-time swap, which cannot know the provider yet. Both paths read the same
 * variants so the protocol cannot drift between prompts and agents. */
export function retrievalGuidanceLinesFor(supportsLsp: boolean): string[] {
  return buildRetrievalGuidance({ supportsLsp, ragWired: true });
}

export function buildRetrievalGuidance(axes: RetrievalAxes): string[] {
  return retrievalVariants()[variantIndex(axes)];
}

/** Rewrite every Haive-owned retrieval fragment for the resolved provider and surface.
 * Everything else remains byte-for-byte unchanged. */
export function adaptRetrievalProtocol(prompt: string, axes: RetrievalAxes): string {
  const index = variantIndex(axes);
  if (index === 0) return prompt;
  let adapted = prompt.replaceAll(
    retrievalVariants()[0].join('\n'),
    retrievalVariants()[index].join('\n'),
  );
  for (const [source, variants] of PROMPT_VARIANT_TABLE) {
    adapted = adapted.replaceAll(source, variants[index]);
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
  const grounding = adaptRetrievalProtocol(prompt, capabilities);
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

/** Rules for implementation agents that may author files under `.ddev/`.
 *
 *  The first rule is the cheapest and the one that has cost the most: a shell command written
 *  as a bare YAML scalar. Task fcf03ead's `- exec: chmod … || (echo 'WARN: chmod failed' >&2;
 *  true)` is not YAML at all — the `: ` inside the message opens a nested mapping — so DDEV
 *  refused the config before creating a container. ddev-config-yaml-guard.ts is what catches
 *  it; this stops it being written.
 *
 *  Agents add `ddev_version_constraint` unprompted — pinning is ordinary DDEV practice — and
 *  some write an EXACT version, which is dead the moment the runner's DDEV differs by a patch.
 *  Observed across six add-ddev tasks: four wrote ranges, two wrote exact pins and both tasks
 *  died at `ddev start`. The runner repairs an exact pin at boot (ddev-version-constraint.ts),
 *  so this is the cheap nudge that stops it being written, not the thing that saves the task.
 *
 *  The second rule is the same shape: `.ddev/web-entrypoint.d/*.sh` is sourced into the web
 *  container's `/start.sh`, which runs `set -o errexit` as an unprivileged user, so a single
 *  root-needing command there makes the container exit with DDEV reporting only "web
 *  container exited". ddev-entrypoint-guard.ts is what actually catches it; this stops it
 *  being written.
 *
 *  The last rule has no guard behind it at all, which is why it is here. A `hooks:` entry runs
 *  a script from wherever the agent put it, in whichever service the hook names, so nothing
 *  can be read ahead of the boot to prove it will succeed — and under `fail_on_hook_fail` a
 *  non-zero exit fails every `ddev start` permanently. Task 4ce9b4e1 lost 3 of its 5 fix
 *  rounds to a post-start hook that refused to start on state its own mariadb init file had
 *  recorded on a previous boot. isDdevHookFailure now routes that back to implementation, but
 *  a hook written non-fatally never gets there.
 *
 *  Gated on the work actually mentioning DDEV so a repo that has nothing to do with it never
 *  pays for the lines. The match is a heuristic, not a contract: a miss costs the nudge, never
 *  correctness — the runtime repair still catches it. */
/** Models narrate: a comment per edit, restating the diff and what it replaced, which turns
 *  the file into the changelog git already keeps. */
export function commentPolicyLines(): string[] {
  return [
    '',
    'Comments: write one only where the code cannot carry the why — a non-obvious constraint, a',
    'workaround, hard math. One practical line, not a paragraph. Do not comment every change, do',
    'not restate what the code plainly says, and do not record what you changed, what it replaced',
    'or what you measured: that belongs in the commit message, not in the file.',
  ];
}

export function ddevConfigGuidanceLines(context: string): string[] {
  if (!/\bddev\b/i.test(context)) return [];
  return [
    '',
    'If you write a shell command into .ddev/config.yaml (a `hooks:` entry, `web_environment:`,',
    'anything): QUOTE the whole value. An unquoted YAML scalar may not contain `: ` (colon then',
    'space), and quotes inside it are literal characters rather than YAML quoting, so',
    "`- exec: echo 'WARN: failed'` is a syntax error. DDEV parses config.yaml before it creates",
    'any container, so one such line fails every `ddev start`. Write',
    '`- exec: "echo \'WARN: failed\'"` instead.',
    '',
    'If you create or edit .ddev/config.yaml: do NOT pin `ddev_version_constraint` to an exact',
    'version (e.g. `v1.25.2`). The DDEV that runs this project is not necessarily the one you',
    'see documented, and an exact pin fails the moment it differs by a patch. Use a range such',
    'as ">= v1.24.0 < v2.0.0", or leave the key out entirely.',
    '',
    'If you add a script under .ddev/web-entrypoint.d/: DDEV SOURCES it into the web container',
    'entrypoint, which runs with `set -o errexit` as the unprivileged `ddev` user. Three ways',
    'to kill the container there, and DDEV reports only "web container exited" for all of them:',
    '- a command needing root (`chown`, `apt-get`, `useradd`, …) fails and aborts the',
    '  entrypoint. Run it under `sudo`, and keep it on the LEFT of a `||` if it may still fail:',
    '  `sudo chown … || echo "warning: …" >&2` reports the problem without killing anything.',
    '- `exit` ends the sourcing shell, so `exit 0` kills the container as surely as `exit 1`,',
    '  and `return 1` does too. Never abort; report and let the script finish, or `return 0`.',
    '- the script re-runs on EVERY start against a workspace that keeps what the last run did',
    '  to it, so it must be idempotent. A path you `chown` to another user is one the `ddev`',
    '  user can no longer write on the NEXT boot — `touch`/`cp`/`>` on it then fails with',
    '  "Permission denied" and aborts the entrypoint, so the first start succeeds and every',
    '  later one exits the container. Create only what is missing (`[ -f X ] || touch X`), do',
    '  the write under `sudo`, or keep it left of a `||`.',
    'Install packages at build time instead, via `webimage_extra_packages` or',
    '.ddev/web-build/Dockerfile.',
    '',
    'If you add a `hooks:` entry to .ddev/config.yaml: it re-runs on EVERY `ddev start`, and',
    'with `fail_on_hook_fail: true` a non-zero exit fails the whole start — permanently, since',
    'the hook is still there on the next attempt and no retry can clear it. So:',
    '- make the hook idempotent, and never make it depend on state a previous boot left behind',
    '  (a marker file, a temp file, a row it wrote last time). It must succeed on a cold',
    '  container with nothing carried over.',
    '- treat anything it cannot control (a file it may not be able to read, a service that may',
    '  not be up yet) as a reason to SKIP its work and exit 0, not to exit 1. Print the reason',
    '  to stderr — DDEV shows it — and let the start finish.',
    '- keep `fail_on_hook_fail` unset unless the project genuinely cannot run without the hook.',
    '  The default already reports a failed hook as a warning.',
  ];
}
