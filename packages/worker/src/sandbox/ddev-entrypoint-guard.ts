import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Pre-flight check that the project's DDEV web-container entrypoint scripts can run at all.
 *
 * `ddev/ddev-webserver`'s `/start.sh` opens with `set -o errexit nounset pipefail` and later
 * calls `ddev_custom_init_scripts`, which `source`s every `.ddev/web-entrypoint.d/*.sh` into
 * that same shell — as the container's UNPRIVILEGED user, because DDEV's generated compose
 * pins the web service to `user: '$DDEV_UID:$DDEV_GID'` (the `ddev` account, uid 1000, in the
 * per-project image). So the first command in one of those scripts that needs root returns
 * non-zero, errexit aborts /start.sh, and the container EXITS before supervisord ever starts.
 * DDEV reports only "web container exited" and points at `ddev logs -s web`.
 *
 * That is what killed task 3b7b8140: an agent-authored `upload-perms.sh` ran
 * `chown -R www-data:www-data` over the docroot's upload directory. Verified against
 * `ddev/ddev-webserver:v1.25.3-<project>-built` — as uid 1000 the plain chown answers
 * `Operation not permitted`, while `sudo -n` is passwordless there and `sudo chown` succeeds.
 *
 * A directory read plus a few file reads turn that into an instant, actionable failure. No
 * repair: rewriting an agent's script behind its back trades one silent failure for another.
 *
 * Deliberately lenient, like the healthcheck, build-input and nginx-include guards: only
 * commands that cannot succeed unprivileged are flagged, a `sudo`-wrapped command is fine,
 * a line whose failure is tolerated (`|| true`) is ignored, and heredoc bodies are treated as
 * data rather than as commands. A false "broken" verdict blocks a working environment, while
 * a false "fine" only returns us to the boot failure we already had — which is now legible,
 * because `budgetContainerLogs` stops the web container's log being evicted from the error.
 */

/** Prefix on every message this module produces. Ours, not DDEV's or the shell's, so the
 *  fix-loop classifier can key on it without depending on anyone else's wording. */
export const DDEV_ENTRYPOINT_PREFIX = 'DDEV web-entrypoint script is invalid:';

/** The directory DDEV exports as `DDEV_WEB_ENTRYPOINT` and sources at web-container start.
 *  Only `*.sh` is sourced, which is why DDEV's own `README.txt` in there is not read. */
const ENTRYPOINT_DIR = 'web-entrypoint.d';

const ROOT_ADVICE =
  'The web container runs as its unprivileged `ddev` user and `/start.sh` runs with ' +
  '`set -o errexit`, so the first failing command aborts the entrypoint and the container ' +
  'exits before supervisord starts — DDEV then reports only "web container exited". Prefix ' +
  'the command with `sudo` (passwordless sudo is available in ddev-webserver), or append ' +
  '`|| true` when the operation is optional.';

const PACKAGE_ADVICE =
  'Installing packages needs root, and belongs at BUILD time in any case: add ' +
  '`webimage_extra_packages` to .ddev/config.yaml, or a `RUN` line to ' +
  '.ddev/web-build/Dockerfile. The entrypoint is unprivileged and re-runs on every start, ' +
  'and a failure there aborts it (`set -o errexit`) so the container exits.';

/** Prefixes that make the rest of the segment privileged, so nothing after them is ours to
 *  flag. */
const PRIVILEGED_PREFIXES = new Set(['sudo', 'doas']);

/** Prefixes that merely wrap the real command, which is the next word. `xargs` is here
 *  because `… | xargs chown` puts chown at the head of its own pipeline segment. */
const COMMAND_WRAPPERS = new Set(['command', 'exec', 'xargs', 'nohup', 'time']);

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

export interface ShellCommand {
  /** Basename of the command word, so `/usr/bin/chown` is recognised as `chown`. */
  command: string;
  args: string[];
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
 * Every command a shell script will actually run, in order.
 *
 * Handles `\` continuations, `&&`/`||`/`;`/`|` chains, `VAR=value` prefixes, command
 * wrappers and `find … -exec`. Comment lines and heredoc BODIES are dropped — a `chown`
 * written into a file for something else to run later is data, not a command this entrypoint
 * executes. So is any logical line ending in `|| true` / `|| :`, which cannot abort the
 * entrypoint, and any segment starting with `sudo`.
 *
 * Not a shell parser and not trying to be: quoting and `$(…)` substitution are left alone.
 * Both can only cost a detection, never invent one, which is the side of the trade this
 * whole guard family sits on.
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
    if (/\|\|\s*(true|:)\s*$/.test(line)) continue;
    for (const segment of line.split(/&&|\|\||;|\|/)) {
      const words = segment.trim().split(/\s+/).map(unquote).filter(Boolean);
      let i = 0;
      while (
        i < words.length &&
        (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || COMMAND_WRAPPERS.has(words[i]!))
      )
        i += 1;
      if (i >= words.length) continue;
      if (PRIVILEGED_PREFIXES.has(words[i]!)) continue;
      out.push({ command: path.posix.basename(words[i]!), args: words.slice(i + 1) });
      for (let j = i + 1; j < words.length - 1; j += 1) {
        if (!FIND_EXEC_FLAGS.has(words[j]!)) continue;
        if (PRIVILEGED_PREFIXES.has(words[j + 1]!)) continue;
        out.push({ command: path.posix.basename(words[j + 1]!), args: words.slice(j + 2) });
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

/**
 * Why this command cannot run in the web entrypoint, or null when it can.
 *
 * The set is small on purpose. Every member writes state only root may write — file
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

export interface DdevEntrypointScript {
  /** File name within `.ddev/web-entrypoint.d/`, quoted back to the agent. */
  name: string;
  content: string;
}

/** Reason the web container will exit inside its entrypoint, or null when no script reaches
 *  for a privilege it does not have. */
export function findDdevEntrypointBreakage(files: DdevEntrypointScript[]): string | null {
  for (const file of files) {
    for (const { command, args } of shellCommands(file.content)) {
      const advice = rootOnlyAdvice(command, args);
      if (!advice) continue;
      return (
        `${DDEV_ENTRYPOINT_PREFIX} .ddev/${ENTRYPOINT_DIR}/${file.name} runs \`${command}\`, ` +
        `which needs root. DDEV sources every script in that directory into the web ` +
        `container's entrypoint on each start. ${advice}`
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
