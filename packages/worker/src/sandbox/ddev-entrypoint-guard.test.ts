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

describe('shellCommands', () => {
  it('follows backslash continuations into one logical line', () => {
    expect(shellCommands('chown -R www-data \\\n  /var/www/html || true\n')).toEqual([]);
  });

  it('splits chains and skips VAR=value prefixes', () => {
    const cmds = shellCommands('mkdir -p /x && FOO=1 chown www-data /x; echo done\n');
    expect(cmds.map((c) => c.command)).toEqual(['mkdir', 'chown', 'echo']);
  });

  it('reduces an absolute path to its basename', () => {
    expect(shellCommands('/usr/bin/chown www-data /x\n')[0]!.command).toBe('chown');
  });
});
