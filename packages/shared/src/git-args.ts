/**
 * Host-side git runs as root over trees a repository, a person or a sandboxed agent can write, and
 * git executes what its own configuration names — hooks, a filesystem monitor, a diff helper, a
 * transport command. These overrides stop that. Every one was MEASURED on git 2.54.0, the version
 * both images ship, against a repository whose own config named a command for each key:
 *
 * - `core.hooksPath=/dev/null` — no hook of any kind is found, and a hook that exits non-zero no
 *   longer fails the commit. A nonexistent path and an empty directory behave identically, so
 *   nothing has to exist on disk.
 * - `core.fsmonitor=false` — the repository's monitor command is not run by status, diff or add.
 * - `credential.helper=` FIRST — an empty value resets the list, and a caller's own helper still
 *   appends after it, which is why these are PREPENDED and a caller's argv is passed verbatim.
 * - `core.sshCommand=ssh` — overrides a repository's while leaving ssh working. An EMPTY value
 *   breaks ssh outright (`error: cannot run : No such file or directory`).
 * - `commit.gpgsign=false` / `tag.gpgsign=false` — a repository asking to sign invokes
 *   `gpg.program`.
 * - `core.pager=cat` — a pager is a command too.
 *
 * The later overrides (askPass, ext and git protocols, alternate refs, signature switches, auto
 * maintenance, editors, submodule recursion) were MEASURED the same way;
 * docs/architecture/sandbox-masking.md has each one.
 *
 * Three keys do NOT yield to `-c`, which is what the per-subcommand flags are for:
 *
 * - `remote.<name>.uploadpack` and `remote.<name>.receivepack` — MEASURED, the repository's command
 *   still ran with `-c` naming the default binary, and only `--upload-pack` / `--receive-pack`
 *   replaced it.
 * - `diff.external` — an EMPTY `-c diff.external=` does not disable it, it makes git run the empty
 *   string: `error: cannot run : No such file or directory` / `fatal: external diff died`, exit 128
 *   on every patch diff. `--no-ext-diff` is the lever, and a `diff.<driver>.textconv` has no config
 *   lever either, so both ride the diff subcommands.
 *
 * A `filter` or `merge` driver named by `.git/info/attributes` has no lever at all —
 * `GIT_ATTR_SOURCE` reaches in-tree `.gitattributes` only — so that one rests on nothing being
 * able to write `.git`.
 */
export const GIT_CONFIG_SAFETY_ARGS: readonly string[] = [
  '-c',
  'credential.helper=',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.sshCommand=ssh',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'tag.gpgsign=false',
  '-c',
  'core.pager=cat',
  '-c',
  'core.askPass=',
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'protocol.git.allow=never',
  '-c',
  'core.alternateRefsCommand=',
  '-c',
  'log.showSignature=false',
  '-c',
  'merge.verifySignatures=false',
  '-c',
  'push.gpgSign=false',
  '-c',
  'tag.forceSignAnnotated=false',
  '-c',
  'maintenance.auto=false',
  '-c',
  'core.editor=:',
  '-c',
  'sequence.editor=:',
  '-c',
  'submodule.recurse=false',
];

/** git's own options, which sit before the subcommand. A value rides the next token for these. */
const GLOBAL_OPTS_TAKING_VALUE: ReadonlySet<string> = new Set([
  '-c',
  '-C',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
]);

/** Where the subcommand sits in an argv that may open with git's own options. */
export function gitSubcommandIndex(args: readonly string[]): number {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('-')) return i;
    if (!arg.includes('=') && GLOBAL_OPTS_TAKING_VALUE.has(arg)) i++;
  }
  return -1;
}

/** The subcommands whose transport command a repository's config can name. */
const PACK_COMMAND_FLAG: Readonly<Record<string, string>> = {
  fetch: '--upload-pack=git-upload-pack',
  pull: '--upload-pack=git-upload-pack',
  'ls-remote': '--upload-pack=git-upload-pack',
  push: '--receive-pack=git-receive-pack',
};

/** The subcommands that read a diff, where an external helper or a textconv driver runs. `status`
 *  rejects the flags outright (exit 129), so this list is named rather than inferred. */
const DIFF_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'diff',
  'log',
  'show',
  'diff-index',
  'diff-tree',
]);

/**
 * The argv Haive actually runs: the safety config first, then the caller's own argv untouched,
 * with the per-subcommand flags `-c` cannot express inserted right after the subcommand.
 *
 * A flag already present is left alone, so a caller that names its own `--upload-pack` keeps it.
 * Every verb refuses the file transport (a local path, a `file://` URL, a bundle file), because
 * git starts a transport under commands that are not transport verbs. The host-folder refresh
 * opts in through the second argument.
 */
export function hardenGitArgs(
  args: readonly string[],
  options: { allowFileTransport?: boolean } = {},
): string[] {
  const at = gitSubcommandIndex(args);
  const transportSafety = options.allowFileTransport ? [] : ['-c', 'protocol.file.allow=never'];
  const out = [...GIT_CONFIG_SAFETY_ARGS, ...transportSafety, ...args];
  if (at === -1) return out;
  const name = args[at]!;
  const extra: string[] = [];
  const pack = PACK_COMMAND_FLAG[name];
  if (pack && !args.some((a) => a.startsWith(pack.split('=')[0]!))) extra.push(pack);
  if (DIFF_SUBCOMMANDS.has(name)) {
    if (!args.includes('--no-ext-diff')) extra.push('--no-ext-diff');
    if (!args.includes('--no-textconv')) extra.push('--no-textconv');
  }
  if (extra.length === 0) return out;
  const insertAt = GIT_CONFIG_SAFETY_ARGS.length + transportSafety.length + at + 1;
  return [...out.slice(0, insertAt), ...extra, ...out.slice(insertAt)];
}

// A control character, a space or one of ~^:?*[\ — the characters git's ref-name rules refuse.
const REF_NAME_FORBIDDEN = /[\u0000- \u007f~^:?*[\\]/;

/** Whether git accepts `name` as a branch name (`git check-ref-format --branch`), the bar a name a
 *  person typed must clear before any git argv carries it. One starting with `-` would be read as
 *  an option, and some options name a command to run. `@` alone is refused too: git reads it as
 *  HEAD rather than as a branch. */
export function isBranchName(name: string): boolean {
  if (name === '' || name === '@' || name === 'HEAD' || name.startsWith('-')) return false;
  if (REF_NAME_FORBIDDEN.test(name) || name.includes('..') || name.includes('@{')) return false;
  if (name.endsWith('.')) return false;
  return name
    .split('/')
    .every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'));
}

/** The entries of a git dir that exist while a merge, rebase, cherry-pick or revert is open, in the
 *  order they are read. Each is located with `git rev-parse --git-path <entry>` and looked up
 *  directly: `rev-parse --verify` would also resolve a branch or tag of the same name, and a rebase
 *  stopped at an `exec` has its state directory but no REBASE_HEAD. The worker's check and the api's
 *  Haive data status both read this list, so they cannot disagree about what counts as open. */
export const GIT_OPERATION_STATE_ENTRIES: readonly string[] = [
  'MERGE_HEAD',
  'REBASE_HEAD',
  'rebase-merge',
  'rebase-apply',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
];
