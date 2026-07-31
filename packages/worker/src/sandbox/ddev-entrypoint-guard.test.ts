import { describe, it, expect } from 'vitest';
import {
  DDEV_ENTRYPOINT_PREFIX,
  findDdevEntrypointBreakage,
  shellCommands,
} from './ddev-entrypoint-guard.js';
import { isDdevAgentFixableFailure } from './ddev-build-guard.js';

/** The script task 3b7b8140 actually shipped, byte for byte. Its `chown` answered
 *  "Operation not permitted" as the container's uid-1000 `ddev` user, errexit aborted
 *  /start.sh, and the web container exited — five days in, with DDEV naming no cause. */
const UPLOAD_PERMS_SH = `#!/usr/bin/env bash
# Post-start hook: Fix file permissions on UserFiles directory
# Ensures uploaded files are not world-writable and owned by www-data

UPLOAD_DIR="/var/www/html/UserFiles"

if [[ -d "$UPLOAD_DIR" ]]; then
  # Recursively fix permissions to prevent unauthorized modification
  find "$UPLOAD_DIR" -type d -exec chmod 755 {} \\;
  find "$UPLOAD_DIR" -type f -exec chmod 644 {} \\;

  # Set ownership to www-data (the Apache FPM user)
  chown -R www-data:www-data "$UPLOAD_DIR"

  echo "$(date '+%Y-%m-%d %H:%M:%S') - Upload directory permissions fixed" >> /tmp/upload-perms.log
else
  echo "$(date '+%Y-%m-%d %H:%M:%S') - UserFiles directory not found (will be created by installer)" >> /tmp/upload-perms.log
fi
`;

describe('findDdevEntrypointBreakage', () => {
  it('catches the exact script that killed task 3b7b8140', () => {
    const reason = findDdevEntrypointBreakage([
      { name: 'upload-perms.sh', content: UPLOAD_PERMS_SH },
    ]);
    expect(reason).toContain(DDEV_ENTRYPOINT_PREFIX);
    expect(reason).toContain('.ddev/web-entrypoint.d/upload-perms.sh');
    expect(reason).toContain('chown');
    expect(reason).toContain('sudo');
  });

  it('routes that failure back to the implementation agent rather than hard-failing', () => {
    const reason = findDdevEntrypointBreakage([
      { name: 'upload-perms.sh', content: UPLOAD_PERMS_SH },
    ])!;
    expect(isDdevAgentFixableFailure(`DDEV cannot start: ${reason}`)).toBe(true);
  });

  it('flags package installs, and says where they belong instead', () => {
    const reason = findDdevEntrypointBreakage([
      { name: 'deps.sh', content: 'apt-get update\napt-get install -y imagemagick\n' },
    ]);
    expect(reason).toContain('apt-get');
    expect(reason).toContain('webimage_extra_packages');
  });

  it('catches a privileged command hidden in find -exec', () => {
    const reason = findDdevEntrypointBreakage([
      { name: 'own.sh', content: 'find /var/www/html -type f -exec chown www-data {} \\;\n' },
    ]);
    expect(reason).toContain('chown');
  });

  it('catches a privileged command behind xargs', () => {
    const reason = findDdevEntrypointBreakage([
      { name: 'own.sh', content: 'find /var/www/html -type f | xargs chown www-data\n' },
    ]);
    expect(reason).toContain('chown');
  });

  // The lenient side. A false "broken" verdict blocks a working environment; a false "fine"
  // only returns us to the boot failure we already had, now visible in the captured logs.
  it('leaves a sudo-wrapped command alone', () => {
    expect(
      findDdevEntrypointBreakage([
        { name: 'ok.sh', content: 'sudo chown -R www-data:www-data /var/www/html/UserFiles\n' },
      ]),
    ).toBeNull();
  });

  it('leaves a command whose failure is tolerated alone', () => {
    expect(
      findDdevEntrypointBreakage([
        { name: 'ok.sh', content: 'chown -R www-data:www-data /var/www/html/x || true\n' },
      ]),
    ).toBeNull();
  });

  // The form the advice recommends, and the reason it does: it satisfies this guard AND a
  // reviewer objecting to swallowed errors. Measured surviving on ddev/ddev-webserver.
  it('leaves the recommended report-and-continue form alone', () => {
    expect(
      findDdevEntrypointBreakage([
        {
          name: 'ok.sh',
          content: 'sudo chown -R www-data:www-data /x || echo "warning: chown failed" >&2\n',
        },
      ]),
    ).toBeNull();
    expect(
      findDdevEntrypointBreakage([
        { name: 'ok.sh', content: 'chown -R www-data:www-data /x || echo "warn" >&2\n' },
      ]),
    ).toBeNull();
  });

  it('leaves a command in an if-condition alone — a non-zero status is the point there', () => {
    expect(
      findDdevEntrypointBreakage([
        { name: 'ok.sh', content: 'if ! chown -R www-data:www-data /x; then echo w >&2; fi\n' },
      ]),
    ).toBeNull();
  });

  it('still flags a root-only command on the left of && or before a ;', () => {
    // Measured: both `chown && …` and `chown; …` kill the shell — only `||` protects.
    expect(
      findDdevEntrypointBreakage([{ name: 'bad.sh', content: 'chown www-data /x && echo ok\n' }]),
    ).toContain('chown');
    expect(
      findDdevEntrypointBreakage([{ name: 'bad.sh', content: 'chown www-data /x; echo after\n' }]),
    ).toContain('chown');
  });

  it('leaves chmod alone — it succeeds on files the container user owns', () => {
    expect(
      findDdevEntrypointBreakage([
        { name: 'ok.sh', content: 'find /var/www/html -type d -exec chmod 755 {} \\;\n' },
      ]),
    ).toBeNull();
  });

  it('leaves a group-only chown alone — that is a chgrp, and can succeed', () => {
    expect(
      findDdevEntrypointBreakage([
        { name: 'ok.sh', content: 'chown -R :www-data /var/www/html\n' },
      ]),
    ).toBeNull();
  });

  it('leaves read-only package queries alone — both succeed as uid 1000 in the image', () => {
    expect(
      findDdevEntrypointBreakage([
        { name: 'ok.sh', content: 'dpkg -l | grep -q imagemagick\napt list --installed\n' },
      ]),
    ).toBeNull();
  });

  it('treats a heredoc body as data, not as commands this entrypoint runs', () => {
    expect(
      findDdevEntrypointBreakage([
        {
          name: 'ok.sh',
          content:
            "cat > /tmp/fix.sh <<'EOF'\nchown -R www-data:www-data /var/www/html\nEOF\necho written\n",
        },
      ]),
    ).toBeNull();
  });

  it('resumes flagging after the heredoc terminator', () => {
    const reason = findDdevEntrypointBreakage([
      {
        name: 'bad.sh',
        content: "cat > /tmp/x <<'EOF'\nharmless\nEOF\nchown -R www-data:www-data /var/www/html\n",
      },
    ]);
    expect(reason).toContain('chown');
  });

  it('ignores commented-out lines', () => {
    expect(
      findDdevEntrypointBreakage([
        { name: 'ok.sh', content: '# chown -R www-data:www-data /var/www/html\necho hi\n' },
      ]),
    ).toBeNull();
  });

  it('is silent on an empty set and on ordinary scripts', () => {
    expect(findDdevEntrypointBreakage([])).toBeNull();
    expect(
      findDdevEntrypointBreakage([
        { name: 'env.sh', content: 'export APP_ENV=local\necho "ready"\n' },
      ]),
    ).toBeNull();
  });
});

// Round 3 of the same task. Told to handle the chown failure rather than swallow it, the
// implementer wrapped it in `|| { echo …; exit 1; }` — which kills the container just as
// dead, because DDEV SOURCES the script into /start.sh. Measured: `exit 1`, `exit 0` and
// `return 1` all kill the sourcing shell; `return 0` does not.
describe('control flow that ends the sourcing shell', () => {
  const ROUND3_SH = `#!/usr/bin/env bash
set -e
UPLOAD_DIR="/var/www/html/UserFiles"

if [[ -d "$UPLOAD_DIR" ]]; then
  if ! id www-data >/dev/null 2>&1; then
    echo "ERROR: www-data user does not exist" >&2
    exit 1
  fi

  chown -RP www-data:www-data "$UPLOAD_DIR" || {
    echo "ERROR: chown to www-data failed" >&2
    exit 1
  }
fi
`;

  it('catches the round-3 rewrite that the fix loop oscillated on', () => {
    const reason = findDdevEntrypointBreakage([{ name: 'upload-perms.sh', content: ROUND3_SH }]);
    expect(reason).toContain(DDEV_ENTRYPOINT_PREFIX);
    expect(reason).toContain('ends the web');
    expect(reason).toContain('return 0');
  });

  it('flags exit 0 too — it kills the container silently', () => {
    expect(
      findDdevEntrypointBreakage([{ name: 'bad.sh', content: 'echo done\nexit 0\n' }]),
    ).toContain('ends the web');
  });

  it('flags return with a non-zero status', () => {
    expect(findDdevEntrypointBreakage([{ name: 'bad.sh', content: 'return 1\n' }])).toContain(
      'ends the web',
    );
  });

  it('leaves return 0 and a bare return alone', () => {
    expect(
      findDdevEntrypointBreakage([{ name: 'ok.sh', content: 'echo hi\nreturn 0\n' }]),
    ).toBeNull();
    expect(
      findDdevEntrypointBreakage([{ name: 'ok.sh', content: 'echo hi\nreturn\n' }]),
    ).toBeNull();
  });

  it('does not mistake the word exit in an argument for the builtin', () => {
    expect(
      findDdevEntrypointBreakage([{ name: 'ok.sh', content: 'echo "exit 1 was not called"\n' }]),
    ).toBeNull();
  });
});

describe('shellCommands', () => {
  it('follows backslash continuations into one logical line', () => {
    // Joined, so the `|| true` on the second physical line still guards the chown on the
    // first — the parser reports the command and tags it, rather than dropping the line.
    const cmds = shellCommands('chown -R www-data \\\n  /var/www/html || true\n');
    expect(cmds.map((c) => c.command)).toEqual(['chown', 'true']);
    expect(cmds[0]!.guarded).toBe(true);
  });

  it('tags only the segment a `||` actually protects', () => {
    const cmds = shellCommands('chown a /x && chown b /y || true\n');
    expect(cmds.map((c) => [c.command, c.guarded])).toEqual([
      ['chown', false],
      ['chown', true],
      ['true', false],
    ]);
  });

  it('splits chains and skips VAR=value prefixes', () => {
    const cmds = shellCommands('mkdir -p /x && FOO=1 chown www-data /x; echo done\n');
    expect(cmds.map((c) => c.command)).toEqual(['mkdir', 'chown', 'echo']);
  });

  it('reduces an absolute path to its basename', () => {
    expect(shellCommands('/usr/bin/chown www-data /x\n')[0]!.command).toBe('chown');
  });
});
