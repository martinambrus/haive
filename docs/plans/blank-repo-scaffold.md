# A blank repo arrives ready, and stops asking to be onboarded

## Context

Creating an empty repository leaves it with a "not onboarded yet" badge and an
Onboard button, offering to onboard a project that contains nothing.

The badge is not the real problem. `tasks/new/page.tsx:303` forces
`type = 'onboarding'` whenever `onboarded === false`, so on a blank repo the
first task CANNOT be a workflow — the user is compelled to run an onboarding
pass over an empty tree before they can do anything. MEASURED: the one blank
repo on the dev install (`vareska`) contains exactly `.git` and `README.md`, and
has 0 tasks, so nobody has walked into this yet.

`onboarded` is four paths existing on disk (`repos.ts:713`):
`.haive-data/knowledge_base`, `.claude/agents`, `.claude/skills`,
`.claude/workflow-config.json`. Blank INIT (`clone.ts:364`) creates a storage
dir, `git init`s it and commits one README — none of the four.

Three of those four are DETERMINISTIC template renders and need no LLM; only the
knowledge base is mined from code, and a blank repo has none. So the fix is to
seed what can honestly be seeded, and to stop offering an onboarding run when
there is nothing to learn from — rather than faking a KB directory, which would
make "onboarded" mean "has directories" and would let the plan canvas offer
"Build from the knowledge base" against an empty one.

**Rollback.** No schema change and no data migration. The seeding only ever adds
files to a repository being created; undoing it is deleting that repository, or
`git rm`-ing the scaffold. The UI half is pure display logic.

## A. Seed the scaffold at blank-repo INIT

`packages/worker/src/repo/clone.ts` (`handleInit`)

Build a minimal `TemplateRenderContext` and write everything
`expandManifestFor()` (`step-engine/template-manifest.ts:281`) returns — the same
function onboarding's post-apply hook and the upgrade-plan step already use, so
there is one definition of "what a repo gets".

The context for a project that does not exist yet:

- `projectInfo`: `REFERENCE_PROJECT_INFO`'s shape with only `name` filled in.
- `framework: null`, `lspLanguages: []`, `customAgentSpecs: []`.
- `acceptedAgentIds: []` — which already means "install every agent"
  (`template-manifest.ts:142` treats an empty list as no snapshot), so a blank
  repo needs no agent-selection decision.
- `agentTargets` / `enabledCliProviders` from the user's enabled providers.
- `rtkEnabled` from `repositories.rtk_enabled`.

Written and committed as part of the SAME initial commit, so a fresh blank repo
has a clean working tree rather than an immediate diff nobody asked for.

**No `onboarding_artifacts` rows are written here.** `task_id` is NOT NULL and
INIT has no task, and the codebase already has the answer: `ranBackfill =
liveRows.length === 0` (`01-upgrade-plan.ts:387`) adopts on-disk template files
into artifact rows with `source: 'backfill'`, which is exactly this situation.
Reusing it beats making a column nullable to accommodate a case that already has
a supported path.

## B. Let the API say there is nothing to onboard

`packages/api/src/routes/repos.ts`

Beside `checkOnboardingMarkers`, answer a second question: does this repository
contain anything worth mining? A shallow read of the repo root, ignoring the
scaffold — `.git`, `README.md`, `.claude/`, `.haive-data/`, `.ripgreprc` and the
rules files (`AGENTS.md`/`CLAUDE.md`/`GEMINI.md`).

Read from DISK, not from `repositories.file_tree`: that column is written once by
`persistDetection` at clone/init time, so on a blank repo that later grows it
would still describe an empty project and the badge would never come back.

Expose `nothingToOnboard` on `GET /repos` and `GET /repos/:id/onboarding-status`:
true when the KB is missing AND no source exists. The repos list already stats
four paths per repo inside a `Promise.all`, so one shallow readdir joins work
that is already happening.

## C. Web — hide an offer that would do nothing

- `app/(app)/repos/page.tsx:346` — hide the "not onboarded yet" badge and the
  Onboard button when `nothingToOnboard`. There is no project to onboard, and an
  action that cannot accomplish anything should not be on screen.
- `app/(app)/tasks/new/page.tsx:303,384` — pick `workflow` when
  `onboarded || nothingToOnboard`. This is the half that actually unblocks the
  user; the badge is cosmetic beside it.

Both flip back on their own the moment the repo has source, because
`nothingToOnboard` is recomputed from disk on every request.

## Files

- `packages/worker/src/repo/clone.ts`, plus a small `repo/blank-scaffold.ts` for
  the context builder so it can be unit-tested without a repo on disk
- `packages/api/src/routes/repos.ts`
- `packages/web/src/app/(app)/repos/page.tsx`,
  `packages/web/src/app/(app)/tasks/new/page.tsx`
- `packages/web/src/lib/api-client.ts` (`nothingToOnboard` on both payloads)

## Verification

1. Unit: the blank render context expands to a set containing the agent specs,
   the skills dir and `workflow-config.json` — asserted against
   `expandManifestFor` rather than a hardcoded file list, so it cannot drift from
   the manifest. API-side, a truth table for `nothingToOnboard`: KB missing + no
   source (true), KB missing + source present (false), KB present (false), and a
   repo whose only content IS the scaffold (true). Then per-container tsc,
   prettier and vitest in worker, api and web.
2. Live: create a blank repository through the UI. Its storage dir must hold
   `.claude/agents`, `.claude/skills` and `workflow-config.json`, `git status`
   must be clean, the repos row must show NO badge and NO Onboard button, and
   `/tasks/new` must offer a `workflow` task rather than forcing `onboarding`.
3. Then write one source file into it and confirm the badge and button RETURN —
   the case that proves the state is derived and not a one-time stamp.
4. Confirm the existing non-blank repos are untouched: an onboarded repo still
   reports `onboarded: true`, and a cloned-but-not-onboarded repo still shows its
   badge (it has source, so `nothingToOnboard` is false).
5. Clean up the test repository and its storage dir afterwards.
