# Fan-out dispatch

**A fan-out reserves every agent before it sends any.** `dispatchMiningAgents` first inserts one
`pending` row per agent, carrying the step's own prompt, its requirements and its timeout rung,
in one transaction, and only then sends them one at a time. A worker that died part-way used to
leave the agents it had not reached with no row at all, so the barrier concluded the step without
them. They now wait `pending` with no invocation, and the barrier sends them from the recorded
prompt without charging an attempt (`dispatchReservedAgents`). A reserved row whose prompt has
aged out of retention is failed rather than waited on.

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

A dispatch that throws part-way fails what it reserved or linked and did not queue
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

**A run's end and its mining result land together, on the row still linked to it.**
`handleCliExecJob` writes both in one transaction, on the success path and the failure path, so no
crash can leave a run ended beside an agent row still `running`. Every write it makes to a mining
row matches the run the row is linked to and only while the row is still `pending` or `running`
(`ownMiningRow`): a re-roll moves the row to a new run, and a late completion of the old one used
to overwrite it; a failed step's release keeps the link, and a run that had already started would
otherwise set its row back to `running`. What follows that transaction (learning a
model limit, the recap, `markCliParkBegin` and handing the step back) sits outside the `try` whose
catch records a failed run, so a queue error there no longer rewrites a finished run as exit -1.
