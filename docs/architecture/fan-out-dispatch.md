# Fan-out dispatch

**A fan-out reserves every agent before it sends any.** `dispatchMiningAgents` first inserts one
`pending` row per agent, carrying the step's own prompt, its requirements and its timeout rung,
in one transaction, and only then sends them one at a time. A worker that died part-way used to
leave the agents it had not reached with no row at all, so the barrier concluded the step without
them. They now wait `pending` with no invocation, and the barrier sends them from the recorded
prompt without charging an attempt (`dispatchReservedAgents`). A reserved row whose prompt has
aged out of retention is failed rather than waited on.

Mining rows also retain host-issued `snapshot_ref` and optional `base_snapshot_ref` identities.
Both are strict version-1 descriptors: owner/task/repository IDs, pinned commit and tree OIDs,
and an inventory ID and SHA-256 digest; they contain no host path or agent-controlled policy.
The host resolves the actual task/repository owner and derives every artifact path under
`<storage>/<user>/_scratch/<task>/committed-snapshots/<inventoryId>/`. It verifies the commit,
tree objects, inventory digest and scope, and tracked file bytes before reservation and again
before execution. One fan-out reuses verified results keyed by inventory ID and full descriptor/
owner/root identity during dispatch; execution never uses that cache. A missing tree may be rebuilt
from those recorded objects; a missing inventory is refused, never recreated from a
live index. Version, pairing, ownership, inventory and object failures never use the checkout.
Materialization defaults to 256 MiB, 50,000 entries, depth 64 and 30 seconds, all injectable.
Serialized inventories are capped at the smaller of 16 MiB and 512 bytes per allowed entry,
with an injectable byte cap shared by issuance and resolution. Issuance refuses an oversized
UTF-8 body before publishing any inventory or descriptor.
The work budget starts after the per-task scratch lock is acquired, so queued siblings do not
spend it waiting. One descriptor-backed Git batch-command child serves object reads for each
issue or resolve. Empty/incomplete crash claims are rebuilt in a private stage and published
under that lock. The old tree is moved aside before the new one is published, so the rebuild
is recoverable, not atomic: a crash between the two leaves a `stage-*` or `incomplete-*`
directory that stays until the task scratch is reaped. Directories are explicitly 0755 regardless of umask; modified bytes, unsafe
ownership/modes, links and files/directories outside the inventory are refused. Every tracked
file must retain its exact issued permission bits: 0444 for a regular blob or 0555 for an
executable blob; missing read bits, added write bits and special permission bits refuse. Tracked
file modes are checked before reading their bytes.
Only regular Git blobs (including executable blobs) are supported; symlinks, gitlinks, traversal,
Git metadata paths and alternate object stores refuse visibly. A shallow clone is supported
when its pinned commit, tree and blobs are present; no history traversal is needed.

Every reservation, link, refusal and queue payload carries both refs. Both row-only recovery
paths, wave recovery, human reruns, timeout rerolls and orphan redelivery preserve the recorded
pin even when selectAgents offers another. A NULL/NULL reservation facing a newly pinned offer
fails with explicit Retry guidance. Resume and recovery retain that generation; explicit Retry
uses the existing reset that deletes reservations and increments `rerun_generation`, allowing a
new analysis to choose new pins. This avoids retargeting an existing reservation or adding a
second generation counter. A `SNAPSHOT_INVALID:` failed agent fails the step at the barrier,
instead of becoming a degraded result that apply could pass. No structural failure-class
column exists: the sentinel recognizes both the direct exec writer and the unsent-release
prefix. A reservation predating snapshots says so and requires Retry. Fixed snapshot errors
retain a cause and log sanitized structured diagnostics; database connection codes, including
SQLSTATE 57P01 through a Drizzle cause, propagate unchanged for normal retry handling.

The optional fields remain in the public module step contract now that a consumer exists.
No core step issues or offers a pin by default: this is opt-in through host-issued descriptors
and the module dispatch seam, with direct issuance currently exercised only by controls.
Rollback must disable new snapshot dispatches and settle queued/live snapshot invocations, while
retaining a capable worker for every resumable pinned task. Deploying an older worker is unsafe
while any snapshot work can resume: it ignores the pin and mounts the live checkout. Retain the
additive columns and inventory evidence; dropping them is not an application rollback.

**Every write that links or fails a row is a compare-and-swap on the state read**
(`sameMiningState`: id, status, invocation link). Two passes over one step, such as a duplicate
advance or a completion racing a retry, used to both re-roll an agent, each superseding the
other's run. Now the loser supersedes only its own new invocation and sends nothing, and only the
winner supersedes the run it replaced. The orphan reconcile's fail write swaps on the link it read
for the same reason: a pass beside it may already have re-rolled the row onto a live run.

**A pass that lost agents to another pass reads the barrier again before it settles.** A first
fan-out, a wave, a re-roll or a user-requested re-run can find its agents taken by a pass running
beside it, and that pass's run may already have finished, so every row the loser read can be
stale: settling on them applied the old failure in place of the new result, or finished a wave
without folding it. `dispatchMiningAgents` therefore reports what it `lost` beside what it sent,
and the loser reads the rows again, once, and settles on those (`rereadMiningBarrier` in the apply
loop). Once is the bound: a pass that loses a second race settles on its second read. A pass that
sent nothing still parks while any row is live (`hasLiveMiningAgents`).

A typed required-integration block before the first stamp is a durable park/dead result, not a
failed dispatch ([Integrations](integrations.md)). It leaves the unsent reservations and their
prompts intact for `dispatchReservedAgents`; the reservation starts at `attempts = 1`, and parking
and recovery do not increment it. The separate entered-continuation bit survives a runtime or
module-schema hold taking over the wait; clearing the active integration cause must not re-ask
`shouldRun` and skip those reservations. No grant, invocation or CLI job is written. Once the first run
has been stamped, the rest share its stamp without another integration resolution, so this block
cannot strand an already-sent sibling. Later stamp insertions still take the module drain
admission guard. A drain includes already-started fan-outs through their current reservations
and linked stamps, so those siblings retain module access until their task finishes; a genuinely
new dependency parks through the same typed wait.

Every other dispatch that throws part-way fails what it reserved or linked and did not queue
(`releaseUnsentAgents`), and ends the one run it had recorded. A pass that fails its step, at any
point (a `selectAgents` that refuses, an enqueue that throws on the second of three agents, a park
write that fails after a wave), then ends the whole fan-out (`releaseStepAgents`) once its own
terminal write is done, so a Resume finds either agents still live (and refuses) or a step that is
already failed: it supersedes
every run the step still has live, which stops itself within seconds instead of spending to its
timeout, and fails every agent row still `pending` or `running`. Left so, such a row would make the
api's Resume refuse the step as still running. It is one transaction in a Retry's lock order (runs,
agents, step) and rolls back only when a Retry has reset the step to `pending`; a Stop that failed
the step meanwhile still wants its agents ended. A concurrent pass can link a run between the run sweep and the agent update. The agent update
returns the runs its rows name; one the sweep missed rolls the release back, and the next attempt
sweeps that run first, so the lock order holds; it repeats while passes keep linking, up to five
attempts, the last of which commits. A deadlock abort also gets that one retry.

**Resume keeps saved replies when apply failed.** A failed step with settled mining rows may
Resume even when every agent is done: the api reopens the step, keeps detection, answers and mining
rows, bumps the task epoch and queues its continuation. It marks only failed agents and done agents
without a saved reply as failed work for the worker's existing user-requested re-dispatch. The parsed payload takes
precedence over raw prose; null or whitespace-only prose is missing, while a structured payload is
saved even without a raw copy. The worker folds the retained replies, preserving `consumed_at` so
wave-aware steps do not fold an earlier wave twice. A done step with all agents done cannot Resume;
the existing recovery of degraded steps with failed agents remains. Live siblings still refuse
Resume, and Retry still deletes every mining row and buys the whole fan-out again. The web offers
the saved-reply action only for a failed step with done rows and no in-flight agents, based on
structural counts and status, never message copy. A fan-out loop with completed
passes (`iterationCount > 0`, with or without `cliRoles`) keeps the loop Resume arm, its unconsumed-invocation sweep and
`resumedFromIteration` response, and the web's "keep N passes" label and confirmation.

The non-resumable refusal remains HTTP 409 with code `not_resumable`. Its copy changed from
"Resume is only available for a multi-iteration step — use Retry instead" to "Resume requires
saved agent work or a resumable pass — use Retry instead"; callers and controls use status and
code rather than that wording.

**A run's end and its mining result land together, on the row still linked to it.**
`handleCliExecJob` writes both in one transaction, on the success path and the failure path, so no
crash can leave a run ended beside an agent row still `running`. Every write it makes to a mining
row matches the run the row is linked to and only while the row is still `pending` or `running`
(`ownMiningRow`): a re-roll moves the row to a new run, and a late completion of the old one used
to overwrite it; a failed step's release keeps the link, and a run that had already started would
otherwise set its row back to `running`. What follows that transaction (learning a
model limit, the recap, `markCliParkBegin` and handing the step back) sits outside the `try` whose
catch records a failed run, so a queue error there no longer rewrites a finished run as exit -1.

**A refusal is one agent's failure, an outage is the step's.** The barrier's fail-fast and the
DAG's sibling cancel key on `isProviderOutage` (`rate_limit`, `auth`, `server_error`), not on every
fatal class: a `content_filter` refusal degrades that agent like any other failed agent, and a DAG
coder, review-loop fix coder or reviewer it refuses fails its own issue, with the refusal kept as the issue's error (read only
from there, never from the agent-written concerns) with no advisor, replanner or retry, since the
same prompt is refused again. An apply that asks to re-roll a refused mining agent gets none
(`isProviderRefusal` in `retryMiningAgents`); only a person's Retry sends it again.
