# Relocate KB + learnings to `.haive-data/`, and make the scope picker knowledge-safe

## Context

Today all project knowledge is written under `.claude/` — the knowledge base at
`.claude/knowledge_base/` (constant `KB_ROOT`, `_kb-write.ts:14`) and durable learnings at
`.claude/learnings/` (workflow step 11). Haive is now model-agnostic: a Codex user's agents live in
`.codex/`/`.agents/`, a Gemini user's in `.gemini/` (registry `CLI_PROVIDER_CATALOG`,
`packages/shared/src/cli-providers/catalog.ts`), yet their project knowledge is still filed under the
Claude vendor dir. That is the wart to remove.

There is also a real, latent picker bug. The onboarding scope pickers
(`06_7-scope-selection`, `09_7-rag-source-selection`) and the repo-settings scope editor
(`packages/web/src/app/(app)/repos/page.tsx`) build a directory tree over the repo
(`buildScopeTree`, `packages/shared/src/repo/scope-tree.ts`) that includes dotfolders. A user can
untick `.claude` / `.haive-data`, which cascades to the knowledge subfolder
(`directory-tree-select.tsx:61-77`) and persists a deny glob to `repositories.scope_exclude_globs`.
The KB survives **only** because both RAG collectors read it through a hardcoded prefix that ignores
the deny list (`collectKbFiles`, `10-rag-populate.ts:83` and `_rag-index.ts:44`). That safety is
accidental — a future refactor making `collectKbFiles` honor scope would silently stop indexing the
KB. We want it guaranteed: the knowledge dirs must never be excludable.

Outcome: knowledge lives at `.haive-data/knowledge_base/` and `.haive-data/learnings/` (the existing
committed onboarding-mirror dir, `HAIVE_DATA_DIR`, restored on clone), and unticking anything in the
folder picker can never stop the KB/learnings from being read, written, or indexed.

**No data migration.** All current data is demo data. Clean cutover: change the canonical paths, no
dual-read, no `git mv`, no back-compat. After the change, demo repos are simply re-onboarded (stale
`.claude/knowledge_base` and old-path RAG rows are ignored/self-cleaned on next sync).

## Design

Two workstreams over one source of truth. `.haive-data/` is already the committed, clone-restored
dir — knowledge rides it for free (step 12 already stages `.haive-data/`; `.haive/` is the
git-excluded one and stays untouched).

### 0. Single source of truth — new leaf module in `@haive/shared`

Create `packages/shared/src/knowledge-paths.ts` (a dependency-free leaf, exported via subpath
`@haive/shared/knowledge-paths` so `@haive/web` can import the helper WITHOUT pulling the
ioredis-laden barrel — same constraint that gates `@haive/shared/scope-tree`):

```ts
import { HAIVE_DATA_DIR } from './types/index.js'; // '.haive-data'  (or inline the literal)
export const KB_DIR = `${HAIVE_DATA_DIR}/knowledge_base`;
export const LEARNINGS_DIR = `${HAIVE_DATA_DIR}/learnings`;
export const INVESTIGATIONS_DIR = `${KB_DIR}/investigations`;
export const KNOWLEDGE_SOURCE_PREFIXES = [`${KB_DIR}/`, `${LEARNINGS_DIR}/`] as const;
/** Dirs that must never be scope-excluded regardless of picker state. */
export const MANAGED_KNOWLEDGE_DIRS = [KB_DIR, LEARNINGS_DIR] as const;
/** Drop any glob equal to or covering a managed knowledge dir (both directions:
 *  a `.haive-data` glob covers them; a `.haive-data/knowledge_base` glob IS one). */
export function stripManagedKnowledgeGlobs(globs: readonly string[]): string[];
```

Re-export these from the shared barrel too (for server packages). Then replace hardcoded
`.claude/knowledge_base` / `.claude/learnings` literals across the codebase with these constants.

### A. Picker safety — knowledge dirs are never excludable

Apply `stripManagedKnowledgeGlobs` at every point a deny frontier is persisted or consumed, so the
guarantee holds even against hand-edited or legacy globs:

- Persist points:
  - `06_7-scope-selection.ts` `apply` — strip before returning `excludeGlobs`.
  - `09_7-rag-source-selection.ts` `apply` — strip before writing `repositories.scope_exclude_globs`.
  - `packages/api/src/routes/repos.ts` PUT `/repos/:id` scope endpoint (~line 626) — strip after the
    existing normalize, as the server-side backstop.
  - `packages/web/src/app/(app)/repos/page.tsx` — strip the `denyFromIncluded` result before PUT so
    the editor never even sends a managed-dir glob.
- Consume points (defense in depth): strip inside the loaders in `_scope.ts`
  (`loadScopeExcludeGlobs`, `loadRepoScopeExcludeGlobs`, `loadMiningScopeExcludeGlobs`) so any
  pre-existing deny list can't exclude knowledge.
- UX affordance (cheap, keeps dirs visible as the user expects): in the two picker `detect` phases
  and the repos page, tag the managed-knowledge `TreeNode`s with `badge: 'always indexed'`,
  `badgeColor: 'green'` (fields already exist on `TreeNode`, `schemas/form.ts:156-163`; no schema
  change). No full "disable" flag is added — functional immunity is what the requirement needs.

Result: the KB/learnings are collected via the hardcoded prefixes (unchanged) AND can never land on
a persisted deny list — doubly immune.

### B. Relocation — clean cutover `.claude/{knowledge_base,learnings}` → `.haive-data/...`

Swap the literals for the constants across the ~20 non-test files. Grouped by concern:

- **Writers / scaffold:** `_kb-write.ts` (`KB_ROOT`, and the `sanitizeKbRelPath` strip regex at
  `:42`); `01-env-detect.ts:1070` (scaffold mkdir array — create `.haive-data/knowledge_base`
  instead of `.claude/knowledge_base`; keep creating `.claude` for agents/skills);
  `08-knowledge-acquisition.ts` (`kbDir`, `scanExistingKb`); `09_3-qa-review.ts` (writes via
  `applyKbWrites`, auto-follows `KB_ROOT`; update prompt paths); `11-phase-8-learning.ts`
  (investigations dir, learnings dir, git-clean pathspec `revertKbSync`).
- **RAG collectors + classify:** `10-rag-populate.ts` (`SOURCE_PREFIXES` → `[KB_DIR + '/']`);
  `_rag-index.ts` (`SOURCE_PREFIXES` → `KNOWLEDGE_SOURCE_PREFIXES`; `classifyKbSourceType` prefixes →
  `INVESTIGATIONS_DIR` / `LEARNINGS_DIR`). Add `.haive-data` to `CODE_IGNORE_DIRS` in both so the
  code collector never walks the mirror tree as code (KB stays picked up by the separate
  `collectKbFiles`).
- **Commit / stage / pathspec:** `12-post-onboarding.ts` — delete the now-redundant
  `.claude/knowledge_base/` from `BASE_STAGE_PATHS` (the existing `.haive-data/` entry covers KB +
  learnings); tidy the `DEFAULT_COMMIT_MESSAGE` prose. `onboarding-upgrade/03-upgrade-commit.ts` —
  replace `.claude/knowledge_base/` with `.haive-data/knowledge_base/` + `.haive-data/learnings/`
  (this list currently has NO `.haive-data/` entry). `11b-kb-commit.ts` (`KB_PATHSPECS`);
  `_knowledge-diff.ts` (pathspec + header comments).
- **Verify / markers / reset (`packages/api/src/routes/repos.ts`):** `07_5-verify-files.ts`
  (KB-count path); `11-final-review.ts` (empty-KB path + message); `repos.ts` `ONBOARDING_MARKERS`
  (`.claude/knowledge_base` → `.haive-data/knowledge_base`; other markers stay in `.claude`);
  `repos.ts` `ONBOARDING_RESET_DIRS` — add `.haive-data/knowledge_base` and `.haive-data/learnings`
  so a re-onboard wipes knowledge (leave the mirror JSONs; they are regenerated at step 12).
- **Readers (workflow):** `03-phase-0a-discovery.ts` (`collectKbSnippets`);
  `04-phase-0b-pre-planning.ts` (`resolveKbReferences` + run-book prompt lines); `09-qa.ts`
  (`listKbFiles`/`collectKbDir` + prompt); `09_5-skill-generation.ts` (`listKbFiles`, reads
  `BUSINESS_LOGIC.md`); `03b-business-requirements.ts`, `09_2-qa-resolve.ts`,
  `_retrieval-guidance.ts` (prompt text).
- **Agent-template prose:** `_agent-templates.ts` (~20 references) — replace `.claude/knowledge_base/`
  with `${KB_DIR}/` in generated agent/command bodies. Also fix the pre-existing inconsistency at
  `:789`/`:801` (`.claude/knowledge_base/learnings.md`) to point at `LEARNINGS_DIR` (learnings are a
  dir of per-id files, not a single log under KB). These are body changes → template `contentHash`
  recomputes on worker boot; **do not bump `schemaVersion`** (per the onboarding-template rules in
  CLAUDE.md). No migration needed for demo repos.

### Docs + tests

- Update `CLAUDE.md` (sandbox/KB/RAG + onboarding-template-versioning sections that name
  `.claude/knowledge_base`) and the `HAIVE_DATA_DIR` doc comment in `packages/shared/src/types/index.ts`
  to note it now also holds knowledge. Fix the cosmetic doc-comment at
  `packages/web/src/lib/api-client.ts:200`.
- Update tests that assert the old paths: `kb-write.test.ts`, `qa-step.test.ts`,
  `qa-review-step.test.ts`, `knowledge-acquisition.test.ts`, `11-phase-8-learning.test.ts`,
  `11b-kb-commit.test.ts`, and the smokes (`workflow-smoke.ts`, `drupal7-onboarding-smoke.ts`,
  `onboarding-full-smoke.ts`, `fix-loop-smoke.ts`, `workflow-commit-smoke.ts`). Add a small unit test
  for `stripManagedKnowledgeGlobs` and one asserting `09_7.apply` drops a `.haive-data` untick.

## Build / verify

Sequencing follows the known dev-stack rules (shared is consumed as built dist; typecheck is
per-container; worker/api pick up shared via restart):

1. Edit `@haive/shared` first, then **rebuild the shared dist** before worker/api use the new
   constants; restart `haive-worker` and `haive-api` so the change goes live.
2. `pnpm typecheck` **inside each package's container** (node_modules are per-container volumes).
3. Run affected Vitest (kb-write, qa, knowledge-acquisition, rag, 11/11b) in the worker container.
4. End-to-end: onboard a fresh demo repo and confirm
   - KB markdown lands under `.haive-data/knowledge_base/`, learnings under `.haive-data/learnings/`;
   - `10-rag-populate` reports `kbFileCount > 0` (RAG indexes the new path);
   - in the picker, untick `.haive-data` (or `.claude`) and submit → the persisted
     `repositories.scope_exclude_globs` contains NO glob covering a managed knowledge dir, and a
     follow-up workflow task still reads/writes KB + learnings;
   - step 12 commit stages the knowledge under `.haive-data/`.

## Rollback

Pure code change behind shared constants — revert the commit to restore prior paths. The
picker-safety strip is additive (it only removes globs that would exclude managed dirs), so reverting
simply restores the old behavior. No data to undo (demo data; no migration performed).

## Adversarial checks / risks

- **External readers of the old path?** The only runtime readers of `.claude/knowledge_base` are the
  step files above and the generated agents (regenerated on re-onboard). `rag_search` MCP reads the
  DB, not the path. Web has no functional dependency (only the cosmetic comment). Confirmed via the
  exhaustive grep — the 20 files above are the complete non-test set.
- **`.haive-data` timing:** KB is now scaffolded at `01-env-detect` and written from step 08, well
  before step 12 stages `.haive-data/`. `.git/info/exclude` only ever gets `.haive/` (worktree
  setup), never `.haive-data/`, so knowledge stays committable in both the main checkout and the
  worktree (workflow learnings commit via `11b-kb-commit`).
- **Clone restore unaffected:** `importHaiveDataMirror` reads only the three mirror JSONs by name;
  added markdown under `.haive-data/` does not touch it.
- **Web bundle:** the picker-safety helper must be imported from the leaf subpath
  `@haive/shared/knowledge-paths`, never the barrel, to avoid dragging ioredis→dns into the browser
  bundle (known constraint).

## Task breakdown (created after approval)

1. Add `knowledge-paths.ts` (constants + `stripManagedKnowledgeGlobs`) + shared subpath/barrel
   exports; rebuild shared dist.
2. Picker safety: strip at persist points (06_7, 09_7, api PUT, repos page) + loaders + green badge.
3. Relocate writers/scaffold/readers/RAG-collectors to the constants.
4. Relocate commit/stage/pathspec + markers/reset in `repos.ts`.
5. Relocate agent-template + step prompt prose.
6. Docs (CLAUDE.md, shared comment, api-client comment) + tests + `stripManagedKnowledgeGlobs` unit
   test.
7. Build/typecheck/test/e2e verify per the section above.
