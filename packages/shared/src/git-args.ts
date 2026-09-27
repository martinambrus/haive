/**
 * One place builds every host-side git argv, so what Haive's git does and does not execute is
 * decided here rather than at forty call sites. This commit only moves the call sites onto it; the
 * overrides themselves are the next commit, and until then the argv is byte-identical to before.
 */
export const GIT_CONFIG_SAFETY_ARGS: readonly string[] = [];

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

/** The argv Haive actually runs: the safety config first, then the caller's own argv untouched. */
export function hardenGitArgs(args: readonly string[]): string[] {
  return [...GIT_CONFIG_SAFETY_ARGS, ...args];
}
