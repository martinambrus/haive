# Committed secret sweep

`07_7-secret-sweep` is a read-only onboarding report over the whole committed
repository. Its scope includes framework core, dependencies, vendored libraries,
build tooling, fixtures and examples. Ownership restricts repairs, not discovery:
a real upstream account password is still exposed when copied into this repository.
Being published upstream is not evidence of revocation. The step never edits files
and its report never enters the committed onboarding artifacts.

Discovery must not depend entirely on the model's choice of searches. MEASURED on
task `be11f2d9-51f8-4bf4-bfa8-d67ab7e4a412`, four successful calls to the same
Claude Opus 5.5 model on the same Haive build reported a vendored bunyip config
only once. The first run used a generic secret-assignment search that included
`libraries/` and opened the config. Later runs restricted generic keyword and
entropy searches to project-owned files while searching the wider tree for
provider formats. The max-effort retry ran for about ten minutes and never opened
the config. More effort cannot compensate for a discovery scope that excludes
ordinary passwords and tokens in dependency tooling.

`_credential-scan.ts` uses the host's hardened `git ls-files -z` inventory and
`readFileNoFollow`, rather than the RAG collector. RAG excludes `build/`, `dist/`,
`vendor/` and generated files for indexing quality; those are legitimate secret
locations. No depth or extension filter narrows the tracked inventory. Binary
content is ignored when it contains NUL. Each read stops at 512 KiB; unreadable
files and truncated reads are counted in internal scan metadata. Sixteen concurrent readers
bound in-flight allocations. Cancellation is checked between files.

The scanner nominates literal credential assignments, selected provider key
formats, private-key markers and credential URLs. These are candidates, not
findings: the model still judges context, placeholders, reach and severity.
Quoted assignments and bounded bare scalars in `.env` and YAML are included;
runtime environment references and function-call prefixes are not nominated.
Named assignments have no minimum credential length beyond being nonempty: short
passwords still expose accounts, and the model decides whether they are real.
Candidates persist only their path, line and a fixed kind, never source text,
credential values, prefixes or hashes. Obvious placeholders and environment
references are filtered as a recall aid; the model's independent whole-tree and
history searches remain required.

The prompt receives at most 200 credential locations, taking one from every
matching file before another from the same file. The entire inventory is scanned
before capping, so the omission count is exact. MEASURED against that task's
37,085-file tree, the scan took about 40 seconds, nominated 188 locations and
included all three bunyip credential lines (13, 20 and 27). Twenty-three files
needed the bounded-read disclosure. This verifies deterministic discovery, not
the model's final classification or current validity at a provider.

The separate opaque-path pre-scan still supplies generated-looking route
segments whose authorization role cannot be found by password keywords. Its
framework/RAG exclusions only apply to that candidate aid, never the sweep's
requested scope or the credential inventory.

Every supplied candidate must return as a finding or a dismissal with its exact
path and line. Free-form statements such as "same for these other files" do not
clear those locations. MEASURED on the first candidate-assisted retry, 115 of 188
locations lacked explicit verdicts: 86 were other lines in files the model had
discussed, and 29 were in additional files, largely generated Bootstrap variants.
Missing entries do not prove the model never inspected their files.

`llm.completePreForm` checkpoints the accumulated report before the results form
is built. The runner consumes the finished invocation and dispatches a focused
follow-up through the normal ownership/reservation path. Each batch contains at
most 24 missing locations and asks for a separate verdict per exact path/line;
source maps and generated copies are inspected rather than assumed equivalent.
The completed invocation ids, pending batch, attempt counts and merged findings
persist in `detect_output.completion`, so a replay cannot spend a batch twice.
Previously reported findings survive later batches and keep their original
invocation attribution. The form and apply merge the saved report with the last
invocation, including when a saved form answer skips the completion hook.

Retries are bounded to three focused attempts per candidate and 32 follow-up
passes. Remaining gaps stay in internal detection records and worker logs, never
in the results form, apply output or recap. The user receives actionable findings
and an optional acknowledgment. An empty report flows through without claiming
the whole repository is clean. The curated summary describes credentials
reported, preventing the recap model from turning internal candidate bookkeeping
into a user-facing coverage warning.

Older persisted detection payloads lack the credential inventory. The LLM
`prepare` hook hydrates it before dispatch and persists it through
`updateOwnedStep`. Reusing a finished invocation skips `prepare`, so completion
hydrates legacy payloads too and gives newly discovered locations focused verdicts
before presenting the form. Unsafe candidate paths are filtered again when building the prompt or
form, and prompt locations sit in an untrusted-text fence. A failed pre-scan is
recorded internally rather than represented as zero candidates; a cancelled scan propagates
cancellation. This inventory covers the current tracked working tree; it does
not deterministically scan historical blobs or validate credentials remotely.
