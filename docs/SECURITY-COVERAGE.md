# Security coverage

What hAIv<sup>e</sup>'s security stages actually examine, and — more usefully — what they do not.

This is a description of the code as it stands, not a statement of ambition. A clean result from
a stage below means "this stage found nothing in what it was given", and the second half of that
sentence is the part worth knowing. If you change what a stage covers, change this file in the
same commit.

The idea of publishing this at all is borrowed from
[Shannon](https://github.com/KeygraphHQ/shannon)'s `COVERAGE.md`.

## Scope, in one line

Everything except the secret sweep is **scoped to a change**. hAIv<sup>e</sup> reviews the diff a
task produced; it does not scan the repository you pointed it at. A vulnerability that was in the
code before the task started is out of scope for every stage on this page except one.

## What runs

### Change-scoped, static — `08c-code-review`

Reviewers run in parallel over the files the task changed.

| Reviewer                 | Looks for                                                                                                                                                                 | When                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `security-code-reviewer` | Injection (SQL/NoSQL, XSS, command, template), access control on privileged paths, secret handling, over-broad data exposure — tracing untrusted input from entry to sink | Always                |
| `peer-reviewer`          | Correctness, edge/error cases, maintainability                                                                                                                            | Always                |
| `operational-reviewer`   | Observability, timeouts and retries, migration safety, backward compatibility, rollback                                                                                   | QA level `standard`+  |
| `performance-reviewer`   | Performance characteristics of the change                                                                                                                                 | QA level `enterprise` |
| `simplicity-reviewer`    | Unnecessary complexity in the change                                                                                                                                      | QA level `enterprise` |

A `critical` or `high` finding blocks and routes the change back through implementation. Before it
does, a **three-lens refuter panel** (reachability, impact, defenses) tries to disprove it; the
finding is dismissed only if **all three** disprove it and each cites a file and line. An
uncertain, unreadable or killed refuter leaves the finding standing.

### Change-scoped, static and advisory — `08c2-code-audit`

One broad auditor reads the changed files against the spec and reports anything wrong, missing or
ambiguous. Report-only: it never blocks, and its findings surface to the human at gate 2.

### Change-scoped, runtime — `08d-adversarial-qa`

Opt-in per task, against the running app. Adversaries are cumulative by level (`poc` = 2,
`standard` = 4, `enterprise` = 6): edge-case breaker, workflow disruptor, auth bandit, injection
infector, logic lunatic, chaos creator.

**Proof-of-concept only.** No persistence, no data deletion, no production disruption. Nothing is
exploited to impact — a finding is evidence that an attack works, not the attack carried out.

### Repository-scoped — `07_7-secret-sweep`

The one stage that reads the whole tree. Once per repository at onboarding, it looks for
credentials **committed** to version control — API keys, tokens, private keys, passwords in
connection strings, service-account JSON. For this pass, tests and fixtures are in scope rather
than skipped, because a real key committed to a test file is live at the provider wherever it
sits. It warns and never blocks.

## Controls, which are not detection

These reduce what an agent can reach. They find nothing and report nothing.

- **Secret-file masking** hides _untracked_ secret files from the CLI agent by bind-mounting empty
  read-only files over them inside the sandbox. Committed secrets are the sweep's job, above.
- **Worktree gitfile masking** blocks an agent from repointing a worktree's `.git` file to give
  itself a working git behind the commit gate. Always on.

## Not covered

Named because a gap you know about is a decision, and a gap you don't is a surprise.

- **Pre-existing vulnerabilities.** Nothing scans the repository as a whole. Every stage above
  except the secret sweep sees only the current change.
- **Truncated changes.** A very large change has its file list capped; when that happens the
  reviewers are told so and the gate reports the review as PARTIAL rather than clean. It is
  disclosed, not silently covered.
- **Dependency and CVE scanning.** No lockfile audit, no advisory database, no SBOM. A vulnerable
  third-party package is invisible here.
- **Infrastructure and deployment configuration.** Container, network, TLS, cloud IAM and CI
  configuration are not examined.
- **Authenticated application surface.** Browser testing reaches only what the app serves without
  logging in. There is no app-credential concept, so for a login-gated app the runtime stages see
  the login page and nothing behind it.
- **Exploitation against a deployed target.** Runtime testing runs against the task's own
  throwaway environment, never a staging or production deployment.
- **Determinism.** These stages reason with language models. Two runs over the same code can
  return different findings, and a finding's absence is not proof of absence.

## Where this sits

hAIv<sup>e</sup>'s security stages complement SAST, dependency scanning and human review; they do
not replace any of them.
