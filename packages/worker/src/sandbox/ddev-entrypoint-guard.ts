import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Pre-flight check that the project's DDEV web-container entrypoint scripts can run at all.
 *
 * `ddev/ddev-webserver`'s `/start.sh` opens with `set -o errexit` and later calls
 * `ddev_custom_init_scripts`, which `source`s every `.ddev/web-entrypoint.d/*.sh` into that
 * same shell — as the container's UNPRIVILEGED user, because DDEV's generated compose pins
 * the web service to `user: '$DDEV_UID:$DDEV_GID'` (the `ddev` account, uid 1000, in the
 * per-project image). Three consequences, and an agent writing such a hook hits all of them:
 *
 *  - a command that needs root returns non-zero, errexit aborts /start.sh, and the container
 *    EXITS before supervisord ever starts;
 *  - because the script is SOURCED rather than executed, `exit` terminates /start.sh itself.
 *    `exit 0` kills the container exactly as dead as `exit 1`, only with a success status and
 *    nothing to show for it, and `return 1` is fatal too — `source` propagates the status and
 *    errexit acts on it;
 *  - the script re-runs on EVERY start against a bind-mounted workspace that keeps whatever
 *    the last run did to it, so a `chown` is not idempotent the way the rest of a hook is: a
 *    path handed to www-data on Monday is one the `ddev` user cannot write on Tuesday. A hook
 *    that chowns a file and then writes it therefore works exactly once (task f33d410a:
 *    `sudo chown www-data … aliases.ser` plus a bare `touch aliases.ser`, which is EACCES on
 *    every later boot).
 *
 * Every one of them makes DDEV report only "web container exited" and point at
 * `ddev logs -s web`.
 *
 * Task 3b7b8140 hit the first shape (`chown -R www-data:www-data` on the docroot's upload
 * directory) and then, when the fix loop asked the implementer to handle errors properly
 * rather than swallow them, the second (`chown … || { echo …; exit 1; }`) — which is why the
 * advice below names a form that satisfies BOTH: keep the command on the left of a `||` and
 * report on the right, so the message survives and the container does not die.
 *
 * Every rule here was measured against `ddev/ddev-webserver:v1.25.3-<project>-built` as uid
 * 1000, not reasoned about:
 *
 *   exit 1 / exit 0 / return 1              -> kills the shell
 *   return 0                                -> survives
 *   bare failing chown / `chown && …` / `chown; …` -> kills the shell
 *   `chown || true`, `chown || echo … >&2`  -> survives
 *   `if ! chown …; then … fi`               -> survives
 *   sudo chown                              -> succeeds (sudo is passwordless there)
 *
 * A directory read plus a few file reads turn a five-day dead end into an instant, actionable
 * failure. No repair: rewriting an agent's script behind its back trades one silent failure
 * for another.
 *
 * Deliberately lenient, like the healthcheck, build-input and nginx-include guards: only
 * commands that cannot succeed unprivileged are flagged, and only where a failure actually
 * aborts the entrypoint. A false "broken" verdict blocks a working environment, while a false
 * "fine" only returns us to the boot failure we already had — which is now legible, because
 * `budgetContainerLogs` stops the web container's log being evicted from the error.
 */

/** Prefix on every message this module produces. Ours, not DDEV's or the shell's, so the
 *  fix-loop classifier can key on it without depending on anyone else's wording. */
export const DDEV_ENTRYPOINT_PREFIX = 'DDEV web-entrypoint script is invalid:';

/** The directory DDEV exports as `DDEV_WEB_ENTRYPOINT` and sources at web-container start.
 *  Only `*.sh` is sourced, which is why DDEV's own `README.txt` in there is not read. */
const ENTRYPOINT_DIR = 'web-entrypoint.d';

/** The form that satisfies both this guard and a reviewer objecting to swallowed errors:
 *  the failure is reported, and the line still returns success so errexit stays quiet. */
const REPORTING_FORM = '`sudo chown … || echo "warning: …" >&2`';

const ROOT_ADVICE =
  'The web container runs as its unprivileged `ddev` user and DDEV sources this script into ' +
  '`/start.sh`, which runs under `set -o errexit` — so the first command that fails aborts ' +
  'the entrypoint and the container exits before supervisord starts, leaving DDEV to report ' +
  'only "web container exited". Run it under `sudo` (passwordless sudo is available in ' +
  'ddev-webserver). If it may still fail, keep it on the LEFT of a `||` so the failure ' +
  `cannot abort the entrypoint — ${REPORTING_FORM} reports the problem without killing the ` +
  'container. Do NOT follow it with `exit` or `return 1`: that kills the container just as ' +
  'surely as the original failure did.';

const PACKAGE_ADVICE =
  'Installing packages needs root, and belongs at BUILD time in any case: add ' +
  '`webimage_extra_packages` to .ddev/config.yaml, or a `RUN` line to ' +
  '.ddev/web-build/Dockerfile. The entrypoint is unprivileged and re-runs on every start, ' +
  'and a failure there aborts it (`set -o errexit`) so the container exits.';

const CONTROL_FLOW_ADVICE =
  'DDEV SOURCES this script into `/start.sh` rather than executing it, so `exit` terminates ' +
  'the entrypoint itself — `exit 0` kills the container exactly as dead as `exit 1`, only ' +
  'with a success status and no error to show for it. `return 1` is fatal for the same ' +
  'reason: `source` propagates the status and errexit acts on it. Report the problem and let ' +
  `the script finish instead — ${REPORTING_FORM} keeps the message and still returns ` +
  'success — or `return 0` when there is genuinely nothing left to do.';

const IDEMPOTENCE_ADVICE =
  'DDEV sources this script on EVERY start, so it has to be idempotent — and a `chown` is the ' +
  'one thing here that outlives the container, because the workspace is a bind mount. Once an ' +
  'earlier boot has handed that path to another user, the unprivileged `ddev` user cannot ' +
  'write it any more: the command fails with "Permission denied", `set -o errexit` aborts the ' +
  'entrypoint, and the container exits. The first start succeeds and every later one dies, ' +
  'which reads as an intermittent failure and is not one. Create the path only when it is ' +
  'missing (`[ -f … ] || touch …`), do the write under `sudo`, or keep it on the LEFT of a ' +
  `\`||\` — ${REPORTING_FORM} reports the problem without killing the container.`;

/** Prefixes that make the rest of the segment privileged, so nothing after them is ours to
 *  flag. */
const PRIVILEGED_PREFIXES = new Set(['sudo', 'doas']);

/** Short options of `sudo`/`doas` that consume the FOLLOWING word, which would otherwise be
 *  mistaken for the command they wrap (`sudo -u root chown …` reads as `root`). The long
 *  spellings are not listed: `--user=root` is self-contained, and `--user root` simply falls
 *  back to a missed detection, which is the lenient direction this module always takes. */
const PRIVILEGED_VALUE_FLAGS = new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U']);

/** Prefixes that merely wrap the real command, which is the next word. */
const COMMAND_WRAPPERS = new Set(['command', 'exec', 'xargs', 'nohup', 'time']);

/** Keywords that put the FOLLOWING command in a tested position, where a non-zero status is
 *  the point rather than a fatal error. Measured: `if ! chown …; then … fi` survives. */
const CONDITION_KEYWORDS = new Set(['if', 'elif', 'while', 'until', '!']);

/** Syntax that precedes a command without changing whether its failure is fatal. */
const BLOCK_KEYWORDS = new Set(['then', 'else', 'do', 'fi', 'done', '{', '}', '(', ')']);

/** `find`'s two ways of spelling "and now run this command per match", which is how a
 *  privileged command hides in the MIDDLE of a segment (`find … -exec chown … {} \;`). */
const FIND_EXEC_FLAGS = new Set(['-exec', '-execdir']);

/** apt subcommands that write outside the user's reach. The read-only ones are excluded on
 *  purpose: `apt list --installed` and `dpkg -l` both SUCCEED as uid 1000 in the DDEV web
 *  image (probed on v1.25.3), so flagging the binary outright would condemn a script that
 *  merely inspects what is installed. */
const APT_MUTATING =
  /^(install|reinstall|remove|purge|update|upgrade|dist-upgrade|full-upgrade|autoremove|autopurge|build-dep)$/;

/** dpkg's mutating flags, same trade as {@link APT_MUTATING}. */
const DPKG_MUTATING = /^(-i|-r|-P|--install|--remove|--purge|--configure|--unpack)$/;

/** Owners that ARE the container user, so handing a path to one takes nothing away. DDEV's
 *  generated compose pins the web service to `$DDEV_UID:$DDEV_GID`, which is the `ddev`
 *  account, uid 1000. */
const CONTAINER_OWNERS = new Set(['ddev', 'ddev:ddev', '1000', '1000:1000']);

/** Commands that write a file's own content or inode, and therefore cannot touch a path the
 *  container user no longer owns. Directory-level commands are deliberately absent: `rm`,
 *  `mv`, `ln` and `mkdir -p` all need permission on the PARENT directory rather than on the
 *  file, and the entrypoint never gives the parent away — flagging them would condemn the
 *  `mkdir -p` that every one of these scripts opens with. */
const WRITING_COMMANDS = new Set(['touch', 'chmod', 'cp', 'tee', 'truncate']);

/** A `>`/`>>` written as its own word. The attached form (`>/path`) is handled separately. */
const WRITE_REDIRECTS = new Set(['>', '>>']);

/** Leading `>`/`>>` on a word, so `>/var/www/html/x` is recognised as a write to that path. */
const REDIRECT_PREFIX_RE = /^>>?/;

export interface ShellCommand {
  /** Basename of the command word, so `/usr/bin/chown` is recognised as `chown`. */
  command: string;
  args: string[];
  /** True when this command's FAILURE cannot abort the entrypoint — it sits on the left of a
   *  `||`, or in an `if`/`while`/`!` condition. Says nothing about the command exiting the
   *  shell outright, which no operator protects against. */
  guarded: boolean;
  /** True when the segment ran under `sudo`/`doas`, so the privilege checks below are not
   *  its to answer. Reported rather than dropped because a privileged `chown` is exactly
   *  what {@link chownedAwayPaths} needs to see — it is the command that takes a path away
   *  from the container user for every LATER start. */
  privileged: boolean;
}

function unquote(word: string): string {
  return word.replace(/^["']|["']$/g, '');
}

/** The terminator word of a heredoc opened on this line, or null when it opens none.
 *  `<<EOF`, `<<-EOF`, `<<'EOF'` and `<<"EOF"` all count; `<<<` (a here-STRING, which
 *  consumes no following lines) deliberately does not. */
function heredocTerminator(line: string): string | null {
  const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line.replace(/<<</g, ''));
  return m ? m[2]! : null;
}

/**
 * Every command a shell script will actually run, in order, each tagged with whether its
 * failure can abort the entrypoint.
 *
 * Handles `\` continuations, `&&`/`||`/`;`/`|` chains, `VAR=value` prefixes, command
 * wrappers, shell keywords and `find … -exec`. Comment lines and heredoc BODIES are dropped —
 * a `chown` written into a file for something else to run later is data, not a command this
 * entrypoint executes — and so is any segment starting with `sudo`.
 *
 * Not a shell parser and not trying to be: quoting and `$(…)` substitution are left alone,
 * and a command inside a function body is reported as if it ran (it does, if the function is
 * ever called). Those can cost a detection or, for the never-called function, add one; the
 * advice is safe to follow either way.
 */
export function shellCommands(text: string): ShellCommand[] {
  const logical: string[] = [];
  let buffer = '';
  let heredoc: string | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (heredoc !== null) {
      if (line.trim() === heredoc) heredoc = null;
      continue;
    }
    if (buffer === '' && /^\s*#/.test(line)) continue;
    const continued = /\\\s*$/.test(line);
    const piece = line.replace(/\\\s*$/, '').trim();
    buffer = buffer ? `${buffer} ${piece}` : piece;
    if (continued) continue;
    if (buffer) logical.push(buffer);
    heredoc = heredocTerminator(buffer);
    buffer = '';
  }
  if (buffer) logical.push(buffer);

  const out: ShellCommand[] = [];
  for (const line of logical) {
    // Splitting with a capture group keeps the operators, so each segment knows what follows
    // it — which is the whole of what decides whether its failure is fatal.
    const parts = line.split(/(\|\||&&|;|\|)/);
    for (let p = 0; p < parts.length; p += 2) {
      const words = parts[p]!.trim().split(/\s+/).map(unquote).filter(Boolean);
      let i = 0;
      let inCondition = false;
      let privileged = false;
      while (i < words.length) {
        const w = words[i]!;
        if (CONDITION_KEYWORDS.has(w)) inCondition = true;
        else if (PRIVILEGED_PREFIXES.has(w)) privileged = true;
        // Once past a `sudo`, a leading `-flag` belongs to sudo rather than to the command it
        // wraps, so it is skipped — along with its value, for the flags that take one.
        else if (privileged && w.startsWith('-')) {
          if (PRIVILEGED_VALUE_FLAGS.has(w)) i += 1;
        } else if (
          !BLOCK_KEYWORDS.has(w) &&
          !COMMAND_WRAPPERS.has(w) &&
          !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)
        )
          break;
        i += 1;
      }
      if (i >= words.length) continue;
      const guarded = inCondition || parts[p + 1] === '||';
      out.push({
        command: path.posix.basename(words[i]!),
        args: words.slice(i + 1),
        guarded,
        privileged,
      });
      for (let j = i + 1; j < words.length - 1; j += 1) {
        if (!FIND_EXEC_FLAGS.has(words[j]!)) continue;
        if (PRIVILEGED_PREFIXES.has(words[j + 1]!)) continue;
        out.push({
          command: path.posix.basename(words[j + 1]!),
          args: words.slice(j + 2),
          guarded,
          privileged,
        });
      }
    }
  }
  return out;
}

/** True when a `chown` invocation changes the file OWNER, which only root may do. A
 *  group-only spell (`chown :www-data`, or the old `chown .www-data`) is really a chgrp and
 *  succeeds for a group the user is already in, so it is left alone. An invocation with no
 *  spec at all is a usage error that is not this guard's to report. */
function chownChangesOwner(args: string[]): boolean {
  const spec = args.find((a) => !a.startsWith('-'));
  return spec !== undefined && !/^[:.]/.test(spec);
}

/** A path this script hands to another user, and whether it did so recursively. */
interface HandedAwayPath {
  path: string;
  recursive: boolean;
}

/**
 * The paths a `chown` invocation takes away from the container user.
 *
 * Empty for the spellings that take nothing: a group-only spec (a chgrp in disguise, which
 * {@link chownChangesOwner} already excuses) and a spec naming the `ddev` user itself, which
 * is who the entrypoint already runs as.
 */
function chownedAwayPaths(args: string[]): HandedAwayPath[] {
  if (!chownChangesOwner(args)) return [];
  const operands = args.filter((a) => !a.startsWith('-'));
  const [spec, ...paths] = operands;
  if (spec === undefined || CONTAINER_OWNERS.has(spec)) return [];
  // `-R`, `--recursive`, and the bundled short form (`-RP`) all descend. Lowercase `-r` is
  // NOT recursive for chown, so it is deliberately not matched.
  const recursive = args.some((a) => a === '--recursive' || /^-[a-zA-Z]*R/.test(a));
  return paths.map((p) => ({ path: p.replace(/\/+$/, ''), recursive }));
}

/** True when `arg` names a path this script handed away — the path itself, or anything under
 *  it when the `chown` was recursive. */
function isHandedAway(arg: string, handedAway: HandedAwayPath[]): boolean {
  const a = arg.replace(/\/+$/, '');
  return handedAway.some((t) => a === t.path || (t.recursive && a.startsWith(`${t.path}/`)));
}

/**
 * The handed-away path this command writes, or null when it writes none.
 *
 * A path is a write target either because the command itself writes what it is given
 * ({@link WRITING_COMMANDS}) or because a `>`/`>>` redirects into it, in which case the
 * command in front is irrelevant — `echo … > f` kills the entrypoint exactly as `touch f`
 * does.
 */
function handedAwayWriteTarget(
  command: string,
  args: string[],
  handedAway: HandedAwayPath[],
): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    // `>path` carries its own target; a bare `>` word leaves it to the next arg.
    const attached = REDIRECT_PREFIX_RE.test(arg);
    const target = attached ? arg.replace(REDIRECT_PREFIX_RE, '') : arg;
    if (!target) continue;
    const redirected = attached || WRITE_REDIRECTS.has(args[i - 1] ?? '');
    if (!redirected && !WRITING_COMMANDS.has(command)) continue;
    if (isHandedAway(target, handedAway)) return target;
  }
  return null;
}

/**
 * Why this command cannot run in the web entrypoint, or null when it can.
 *
 * The root-only set is small on purpose. Every member writes state only root may write — file
 * ownership, /etc/passwd, the dpkg database — which is a property of the syscall rather than
 * of a DDEV version, so it does not go stale. `chmod` and `chgrp` are deliberately absent:
 * chmod succeeds on every file the container user owns (most of the bind-mounted workspace)
 * and chgrp succeeds for a group the user is already in, so flagging either would condemn
 * working scripts.
 */
function rootOnlyAdvice(command: string, args: string[]): string | null {
  switch (command) {
    case 'chown':
      return chownChangesOwner(args) ? ROOT_ADVICE : null;
    case 'useradd':
    case 'usermod':
    case 'groupadd':
    case 'adduser':
      return ROOT_ADVICE;
    case 'apt':
    case 'apt-get':
      return args.some((a) => !a.startsWith('-') && APT_MUTATING.test(a)) ? PACKAGE_ADVICE : null;
    case 'dpkg':
      return args.some((a) => DPKG_MUTATING.test(a)) ? PACKAGE_ADVICE : null;
    default:
      return null;
  }
}

/** True when this command terminates the SOURCING shell — i.e. /start.sh — rather than just
 *  this script. No operator protects against it, so `guarded` is not consulted: measured,
 *  `exit 1`, `exit 0` and `return 1` all kill the shell, while `return 0` and a bare `return`
 *  (whose status is whatever ran last) do not. */
function endsTheEntrypoint(command: string, args: string[]): boolean {
  if (command === 'exit') return true;
  if (command !== 'return') return false;
  const code = args[0];
  return code !== undefined && /^\d+$/.test(code) && Number(code) !== 0;
}

export interface DdevEntrypointScript {
  /** File name within `.ddev/web-entrypoint.d/`, quoted back to the agent. */
  name: string;
  content: string;
}

/** Reason the web container will exit inside its entrypoint, or null when no script reaches
 *  for a privilege it does not have, ends the sourcing shell, or writes a path it has
 *  already handed to another user.
 *
 *  The two passes are ordered by WHEN they bite: the first pass finds what kills the very
 *  first start, the second what kills every start after it. Reporting the first-boot cause
 *  first keeps the message pointed at what the agent will actually observe. */
export function findDdevEntrypointBreakage(files: DdevEntrypointScript[]): string | null {
  for (const file of files) {
    const where = `${DDEV_ENTRYPOINT_PREFIX} .ddev/${ENTRYPOINT_DIR}/${file.name}`;
    const commands = shellCommands(file.content);
    for (const { command, args, guarded, privileged } of commands) {
      if (privileged) continue;
      if (endsTheEntrypoint(command, args)) {
        return (
          `${where} calls \`${command}${args[0] ? ` ${args[0]}` : ''}\`, which ends the web ` +
          `container's entrypoint. ${CONTROL_FLOW_ADVICE}`
        );
      }
      if (guarded) continue;
      const advice = rootOnlyAdvice(command, args);
      if (!advice) continue;
      return (
        `${where} runs \`${command}\`, which needs root, where a failure aborts the ` +
        `entrypoint. DDEV sources every script in that directory into the web container's ` +
        `entrypoint on each start. ${advice}`
      );
    }

    // Second pass, and it needs the WHOLE script first: the `chown` that poisons a write can
    // sit either side of it, because what matters is the state the previous start left behind
    // rather than the order of lines within one run.
    const handedAway = commands.flatMap((c) =>
      c.command === 'chown' ? chownedAwayPaths(c.args) : [],
    );
    if (handedAway.length === 0) continue;
    for (const { command, args, guarded, privileged } of commands) {
      if (guarded || privileged) continue;
      const target = handedAwayWriteTarget(command, args, handedAway);
      if (!target) continue;
      return (
        `${where} runs \`${command}\` on \`${target}\`, which the same script hands to another ` +
        `user with \`chown\` — so the write succeeds on the first start and fails on every ` +
        `one after it. ${IDEMPOTENCE_ADVICE}`
      );
    }
  }
  return null;
}

/**
 * Read the workspace and apply {@link findDdevEntrypointBreakage}.
 *
 * Returns null when nothing is wrong, when there is no `.ddev/web-entrypoint.d/`, or when the
 * tree cannot be read — an unreadable workspace is the boot's problem to report, not this
 * check's.
 */
export async function checkDdevWebEntrypoints(workspace: string): Promise<string | null> {
  const dir = path.join(workspace, '.ddev', ENTRYPOINT_DIR);
  const names = await readdir(dir).catch(() => null);
  if (names === null) return null;

  const files: DdevEntrypointScript[] = [];
  for (const name of names.filter((n) => n.endsWith('.sh')).sort()) {
    const content = await readFile(path.join(dir, name), 'utf8').catch(() => null);
    if (content !== null) files.push({ name, content });
  }
  return findDdevEntrypointBreakage(files);
}
