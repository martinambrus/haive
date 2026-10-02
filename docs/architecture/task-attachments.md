# Task attachments

**Attachments exist before the worker reads them, or the task never starts.** The plan
builder's first step reads the uploads dir and the worker picks a job up immediately, so
`POST /plan/build` with `deferStart` creates the row WITHOUT enqueueing; the client streams
files through the ordinary attachment route and finalizes with the `start` task action, which
claims `status = 'created'` in one atomic UPDATE (a second click matches no row and enqueues
nothing). An upload that fails therefore cannot start anything — the draft is the repair
surface, reachable from its Attachments tab. This replaced the inline-document seed hook,
which could carry exactly one file. `_ATTACHMENTS.md` is regenerated after every write: the
prompt notice names that file unconditionally, so a path that skipped it handed the agent a
pointer to nothing. Every writer — upload, delete and archive expansion — goes through ONE
function, `rewriteAttachmentsManifest`
(`@haive/shared/attachments-fs`, Node-only and outside every subpath web imports), and it NEVER
throws: it runs after the work it describes, so a refusal there answered 500 for an upload that had
already happened, and the client's retry stored the file twice. A link planted at a GENERATED name
(the manifest, `_PLAN_INPUTS.md`, a sidecar) is replaced as a link (`writeFileNoFollow`'s
`replaceLeafLink`, which never follows it and inherits nothing from it) rather than blocking every
later write; anything else standing there is logged and left, and `00-plan-inputs` carries on
without that index or sidecar instead of failing the step.

**An attachment's `filename` is a RELATIVE PATH, not a basename.** That single fact is both
folder upload and archive expansion: the browser sends `webkitRelativePath` from a
`webkitdirectory` input (its own button beside the file picker, never a mode on it), and
expanding an uploaded archive produces exactly the rows a folder upload would have. Nothing
downstream needed a special case, because `resolveTaskUploadsMount` already bind-mounts the
WHOLE uploads dir and every consumer joins the name onto it. The rules live in
`@haive/shared/attachments` so the api (on upload) and the worker (on expansion) cannot
disagree about a name: a `..` segment THROWS rather than being dropped — every legitimate
producer can express a path without one, so its presence is an upload to refuse (400), not a
name to repair quietly — and leading dots are stripped per SEGMENT, so no dotfile or
dot-directory survives anywhere. De-dupe is per DIRECTORY: two folders' `README.md` are two
documents. It keeps an archive's two-part extension whole (`splitAttachmentExtension`): a second
`spec.tar.gz` is `spec (2).tar.gz`, never `spec.tar (2).gz`, which no archive rule recognises.

`ensureArchivesExpanded` (`worker/src/attachments/expand-archives.ts`) runs lazily wherever the
attachments are read for an agent: `00-plan-inputs.detect`, `loadLiveAttachments` (so the live plan
inputs see an archive's members, not a `binary` zip), and before `augmentPromptWithAttachments` in
`step-runner` and in `dag-executor`, each time either builds an agent's prompt, so
every task type gets it and the notice never names a `.zip` no agent can open. It reuses
`repo/clone.ts`'s `extractArchive` (`unzip` and `tar` are in the WORKER image, not the api's;
its `flattenSingleTopLevel` is what stops `spec.zip` becoming `spec/spec/`), then walks the
result with `lstat` and keeps REGULAR FILES ONLY — a symlink is how an archive reaches out of
the directory it was extracted into — re-checking every path even though the extractor claims
to sanitise. All-or-nothing per archive: over `ATTACHMENT_ARCHIVE_MAX_FILES` (500) or
`ATTACHMENT_ARCHIVE_MAX_TOTAL_BYTES` (512 MiB) it inserts NOTHING and records
`expansion_note`, because half a specification is worse than none — nothing downstream can
tell which half it was given. The cap is measured AFTER extraction on purpose: the alternative
parses `unzip -Z`/`tar -tv` human-facing output, and a bomb is exactly the input that lies in
it. `expanded_at` is stamped for every archive that will not expand — a cap breach, an unreadable
archive, no free folder name — or a failed archive is re-extracted on every step for the life of
the task. A PLACEMENT that fails is the one exception: it takes back all it placed and leaves the
archive a candidate, since a lost database round trip is no verdict on the archive.
`expanded_from_id` cascades the rows AND is what makes "nested archives are not recursed"
structural (a row with a parent is never a candidate). The FK
cannot reach the disk, so a delete removes what the attachment left there too
(`attachmentRemovalPlan`): an archive's MEMBERS, which a folder delete has to reach at the uploads
ROOT (`docs/x.zip` expands into `x/`), and each document's extracted-text SIDECAR. A delete that takes
the LAST file extracted from an archive takes the archive too (`archivesEmptiedBy`,
`@haive/shared/attachments`, which the panel's confirmation names from the same rule), or it would
stay listed as expanded with nothing of it left and never be expanded again. A file a SURVIVING row
still names is never removed: the upload claim reads the disk, not the rows, so two rows can name one
file, and deleting one must not take the other's. It removes FILES,
never a directory, and a folder goes only by pruning once it is empty: a recursive removal takes
whatever else lives there — a later upload named like the expansion directory lands inside it (the
api de-dupes files, not directories), and an upload racing the delete has its file on disk before
its row exists, where no list of rows can see it. That makes the rows the whole inventory, and two
rules keep them so: no attachment may take a name a generated file owns, and no expansion leaves a
placed file without its row (below). The first rule is ONE predicate
(`isReservedAttachmentName`, `@haive/shared/attachments`) that an upload, an archive member and an
expansion folder all apply: `_ATTACHMENTS.md` and `_PLAN_INPUTS.md` at the root, `*.extracted.md` at
any depth, since a delete unlinks a document's sidecar path whether or not the sidecar exists yet. A
file is probed onto the next free ` (n)` name; a FOLDER is renamed `<name> (2)` deterministically
(`reserveAttachmentDirs`), because a folder upload is one request per file and every file of it has
to land in the same place. Neither may be left: an orphaned tree stays bind-mounted, and an agent
would keep reading files the user believes they removed.

**One lock serialises every write that changes which files a task has.** `withTaskAttachmentsLock`
(`@haive/database`) is a transaction-scoped advisory lock keyed on the task — `plan/mirror.ts`'s
shape — that the api and the worker share: an upload CLAIMING its name, a delete from reading its
rows to rewriting the manifest, a sidecar stored only while its row exists, and every manifest
rewrite. A delete removes a sidecar path and its row in one section, so no sidecar can land between
the two; that replaced a two-sided check in which the api removed sidecars twice and the worker
looked for the row after writing. Three rules make it safe to hold. Sections are SHORT — never
across an upload stream or an archive extraction, because every waiter holds a pooled connection
and both pools are `max: 10`. Everything inside goes through `tx`, never the pool. And nothing that
takes the lock is called on the POOL from inside a section: handed `tx`, it nests as a savepoint,
where the lock is re-entrant. A wait past 30s is `55P03` (`isLockNotAvailable`): the api answers 503
having changed nothing, and the worker counts it as a per-item miss — a sidecar not stored, a
missing file still missing. `00-plan-inputs` re-checks a file it found gone under the lock before
calling it missing, since a delete removes files before rows and a deleted attachment is not a
missing one. The upload's INSERT stays outside the lock with its id chosen beforehand, so one whose
answer was lost can be told from one that failed: the file is taken back only when a second look
finds no row, since answering 500 for a stored upload sends the client's retry to store it twice.

**The expansion is the lock's longest section, and a crash anywhere in it leaves something the
next call can settle.** Each attempt extracts OUTSIDE the lock into its own
`.expanding-<archiveId>-<nonce>` staging dir and builds the finished tree there. The dir is 0700:
the extraction tool is handed its directory as a descriptor and never resolves it by name, so only
the worker enters it. The nonce is what stops a second call
moving the first's tree aside, which `extractArchive` does to any existing destination. One locked
section then re-checks that the archive is still unstamped, settles earlier attempts at it, claims
the first free folder by moving the tree WHOLE (`renameNoFollow` with `noReplace`), and writes every
member row and the stamp together — so two overlapping calls produce one tree. Before each move it
writes `placed-as`, naming the folder and its files, and the staging dir goes only after a confirmed
COMMIT, so an attempt that died after its move and before its rows is taken back by the next call
to hold the lock: whatever `placed-as` names that no row owns is removed. A tree still staged means
the move never happened, and then only the claimed folder goes, and only while it is an empty
directory. The intent is untrusted — the sandbox can write the uploads dir — so it may name one
folder and only names an expansion could have written: a sidecar has no row, and an intent naming
one would pass live extracted text off as an orphan. Nor more names than an archive may hold, since
each is a bind parameter of the settle's one query, and a list past Postgres' limit fails a delete's
section after its files have gone. A throw after the move takes the files back
INSIDE the callback, since postgres.js can reject the transaction while the callback still runs.
Every call first settles the attempts at archives deleted or stamped since, re-checked under the
lock, so an archive attached a moment ago keeps its attempt in flight. A DELETE settles the attempts
at the archives it removes in its own section (`settleExpansionAttempts`,
`@haive/shared/attachments-fs`), and a staging dir it then fails to remove is swept by the next
expansion call. The worker finds the uploads dir through a row, so once the last attachment is gone
it sweeps under the task repository's storage path, the one root an upload is ever written under,
and never in a read-only local repository. Settling
removes the intent inside the section, so no later settle acts on it twice — a name it freed is one
an upload can take, and that upload's file has no row until its bytes are in. An upload's claim
settles every attempt that wrote its intent before it takes a name (`settleExpansionIntents`): a
dead attempt's intent can still name a path free on disk, and settling it once the upload held that
name would take the upload's file before its row existed. Their staging dirs go after its section,
as a delete's do. The staging dirs
themselves are removed AFTER the section (`removeExpansionStagings`), never inside it: one can hold
a whole extracted archive, and removing it there would hold the lock and a pooled connection for as
long as that takes.

**`expansion_note` is the one durable account of what an archive lost, so it is read from the
column.** The expansion call reports only the archives THAT call expanded, so a later step, a
retried `00-plan-inputs`, and every workflow task (whose call site discards the result) used to
see nothing. `augmentPromptWithAttachments` now names each incomplete archive in an INCOMPLETE
ARCHIVES block, `00-plan-inputs` takes its `archiveNotes` from the column, and the attachments
panel shows it under the archive (`archiveExpansionBanner`, `web/src/lib/step-banners.ts`). All
three gate on `expanded_at`; the note is only the words. It carries archive member names (tar
keeps a name's bytes, newlines included) and an extractor's error line, so it is WRITTEN as one
bounded line (`expansionErrorLine`, `describePathDrops`) and collapsed and capped AGAIN wherever
it meets a prompt (`safeNote`), because rows written before that exist.

Three caps exist because a folder is not a handful of files. `augmentPromptWithAttachments`
rides every agent that works from the task's content: the LLM phase, each agent of a mining
fan-out (built once per fan-out, joined ahead of the ledger and terseness in `resolveLlmPhase`'s
order), and each DAG coder, reviewer, fix coder and issue advisor. The DAG replanner and merge-fix
agent go without it: the first is handed the issue graph and no specification, the second resolves
a git conflict. A RECOVERED mining agent, a wave agent `selectAgents` never authored, is sent the
prompt its step wrote (`task_step_agent_minings.dispatch_prompt`), which is augmented once with what
the task knows now and adapted once for the provider that takes it. A row written before that column
has only its last run's stored prompt, already the effective one, so it is replayed verbatim:
augmenting it again duplicated the terseness block and could duplicate the ledger. So past
`ATTACHMENT_PROMPT_FILE_LIMIT` (40)
the notice collapses to one
counted line per top-level folder and states the elision the way `changedFilesBlock` does —
under the limit the output is byte-identical to what it always was. `00-plan-inputs` bounds
sidecar EXTRACTIONS (a subprocess each) at 50, and a document past that is
`extractionSkipped`, deliberately NOT folded into `visualOnly`: that is a hard vision
requirement on the dispatch and must rest on a measurement, and "the extractor never ran" is
not one. `02-plan-coverage` caps displayed gap candidates at 60, since each carries its body
into the persisted detect payload and becomes a checkbox a person has to read; a re-run
filters out the handled ones, so the remainder is the next round's list. The on-disk
`_ATTACHMENTS.md` and `_PLAN_INPUTS.md` stay UNCAPPED — they are where the prompt sends a
reader for the names it could not fit.
