# Workflow commits

Before `git add -A`, both gate 3 and the DAG issue committer run `assertDependencyCommitSafe`.
It checks uncapped untracked paths and tracked changes against the task's fork point, including
earlier issue commits, deletions and both sides of renames. Modified infrastructure and
third-party source refuse the commit. Restoring upstream source to its baseline is allowed.
Ownership comes from the baseline policy described in [Review scope](review-scope.md), never
a declaration introduced by the agent. Package manifests, lockfiles, patch files and project
integration code remain valid commit artifacts. `.patch` and `.diff` artifacts under the
project's `patches/` directory may mirror upstream package names; files inside installed
packages remain upstream even when they themselves are patches. This guard checks Git deliverables; ignored
installed source and ad-hoc scripts are constrained by the agent rules and review, rather than
being inspected by this path check.
Baseline and working Composer manifests are parsed independently, so a repaired manifest can
establish protection even when the committed copy is malformed; valid baseline evidence still
protects infrastructure when the current copy is broken or removes the framework declaration.

`10-gate-3-commit` generates its message with a pre-form LLM invocation. Detection remains
deterministic: the worker builds the commit-diff snapshot from the same staged, unstaged and
untracked files `git add -A` will include. The message invocation receives bounded before/after
excerpts from that snapshot, with unchanged edges stripped so edits near the end of large files
remain visible. Binary files and oversized content carry metadata only; truncation is explicit.
The snapshot is against HEAD, because this message describes the pending commit rather than
the whole task's changes already committed by DAG execution or prior fix rounds.

The invocation asks for a JSON `commitMessage` containing a subject and optional body and
instructs the agent to answer from the supplied changes without using tools. `disableTools`
is a best-effort optimization: adapters that support it disable built-in tools; the others
keep them available and remain eligible. The gate never switches away from the selected CLI
because it cannot disable tools. `toolProfile:'none'` still wires no MCP servers, including
on Muse where disabled built-in tools and deferred MCP tools can cause a provider error.
Git remains host-side. Change evidence is fenced at prompt-build
time. The selected provider's operator rules remain injected, including commit conventions;
the step's explicit JSON contract takes precedence where necessary. Evidence fencing covers
older persisted detect payloads that only have the diff summary. Repository
secret-mask policy removes denied file contents from the message context; it conservatively
omits tracked secret contents too and applies even with masking switched off. Git may not pair
a moved file (`status.renames=false`, content rewritten below the similarity threshold, or a move
over a tracked file), so a denied file moved to an allowed name arrives as a deletion plus an
addition or a modification, a moved file's old path can be recreated in place, and a protected file
staged then moved reads as `AD` plus an untracked copy: when any denied path appears in the change,
under any status, or the change list is capped and may not show every change, no file but a
deletion shows its content, only its path. A failed policy lookup leaves only the diff summary
available, never the unfiltered contents.

The LLM runs before the gate parks and its suggestion becomes the editable form default. The
web changes viewer stays hidden until the form schema is ready, so the terminal can mount
above it without shifting an already visible diff. Completed and skipped gates keep their
diff available, including older records without a persisted form schema. Generation skips
clean workspaces and non-git directories and is optional, with one re-roll for
unusable output: without a usable suggestion the form offers manual entry, never the old static
`feat: apply workflow changes` fallback. Apply uses the submitted message, or the generated
suggestion when the field is absent, and rejects an explicitly blank message before staging.
The optional fallback also applies when the worker supplies an empty or entirely disabled
provider list and dispatch returns no invocation; required LLM steps still fail in that case.
The user can still skip committing. Step-runner retains the invocation through form submission
and recovery using its existing pre-form lifecycle.

The gate tests cover real git changes, message overrides, output validation, containment and
secret omissions. `step-runner-llm.test.ts` exercises the actual gate definition through
`waiting_cli` to `waiting_form` and submission. `workflow-commit-smoke.ts` fabricates its change
before gate 3 detection and verifies that the bypass LLM message prefills the form.
