# Workflow commits

`10-gate-3-commit` generates its message with a pre-form LLM invocation. Detection remains
deterministic: the worker builds the commit-diff snapshot from the same staged, unstaged and
untracked files `git add -A` will include. The message invocation receives bounded before/after
excerpts from that snapshot, with unchanged edges stripped so edits near the end of large files
remain visible. Binary files and oversized content carry metadata only; truncation is explicit.
The snapshot is against HEAD, because this message describes the pending commit rather than
the whole task's changes already committed by DAG execution or prior fix rounds.

The invocation uses no tools or MCP servers and asks for a JSON `commitMessage` containing a
subject and optional body. Git remains host-side. Change evidence is fenced at prompt-build
time, including older persisted detect payloads that only have the diff summary. Repository
secret-mask policy removes denied file contents from the message context; it conservatively
omits tracked secret contents too and applies even with masking switched off. A failed policy
lookup leaves only the diff summary available, never the unfiltered contents.

The LLM runs before the gate parks and its suggestion becomes the editable form default. It
skips clean workspaces and non-git directories. Generation is optional, with one re-roll for
unusable output: without a usable suggestion the form offers manual entry, never the old static
`feat: apply workflow changes` fallback. Apply uses the submitted message, or the generated
suggestion when the field is absent, and rejects an explicitly blank message before staging.
The user can still skip committing. Step-runner retains the invocation through form submission
and recovery using its existing pre-form lifecycle.

The gate tests cover real git changes, message overrides, output validation, containment and
secret omissions. `step-runner-llm.test.ts` exercises the actual gate definition through
`waiting_cli` to `waiting_form` and submission. `workflow-commit-smoke.ts` fabricates its change
before gate 3 detection and verifies that the bypass LLM message prefills the form.
