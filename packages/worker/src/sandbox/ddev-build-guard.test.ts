import { describe, expect, it } from 'vitest';
import {
  dockerfileRunCommands,
  findDdevBuildBreakage,
  findDdevSpecBreakage,
  DDEV_BUILD_INPUT_PREFIX,
  isBuildDockerfile,
  isDdevAgentFixableFailure,
  isDdevBuildInputFailure,
  isDdevContainerConfigFailure,
  isDdevEntrypointRuntimeFailure,
  isDdevHookFailure,
} from './ddev-build-guard.js';
import { findDdevNginxIncludeCollisions } from './ddev-nginx-include-guard.js';

describe('dockerfileRunCommands', () => {
  it('reads the command out of a plain RUN line', () => {
    expect(dockerfileRunCommands('RUN docker-php-ext-install mysql')).toEqual([
      'docker-php-ext-install',
    ]);
  });

  it('reads every command of a chain', () => {
    expect(
      dockerfileRunCommands(
        'RUN apt-get update && apt-get install -y php8.3-gd; pecl install redis',
      ),
    ).toEqual(['apt-get', 'apt-get', 'pecl']);
  });

  it('joins line continuations before splitting', () => {
    const text = ['RUN apt-get update \\', '    && docker-php-ext-enable redis'].join('\n');
    expect(dockerfileRunCommands(text)).toEqual(['apt-get', 'docker-php-ext-enable']);
  });

  it('skips comments and non-RUN instructions', () => {
    const text = ['# RUN pecl install redis', 'ENV FOO=bar', 'COPY x /y'].join('\n');
    expect(dockerfileRunCommands(text)).toEqual([]);
  });

  it('skips VAR=value prefixes and sudo', () => {
    expect(dockerfileRunCommands('RUN XDEBUG_MODE=off sudo composer install')).toEqual([
      'composer',
    ]);
  });

  it('reduces an absolute path to its basename', () => {
    expect(dockerfileRunCommands('RUN /usr/local/bin/pecl install redis')).toEqual(['pecl']);
  });

  it('ignores a line that cannot fail the build', () => {
    expect(dockerfileRunCommands('RUN docker-php-ext-install mysql || true')).toEqual([]);
  });

  it('reads the JSON exec form', () => {
    expect(dockerfileRunCommands('RUN ["pecl", "install", "redis"]')).toEqual(['pecl']);
  });
});

describe('findDdevBuildBreakage', () => {
  const file = (content: string) => [{ name: '.ddev/web-build/Dockerfile', content }];

  it('names the command, the file and the DDEV-native alternative', () => {
    const reason = findDdevBuildBreakage(file('RUN docker-php-ext-install mysql'));
    expect(reason).toContain('.ddev/web-build/Dockerfile');
    expect(reason).toContain('docker-php-ext-install');
    expect(reason).toContain('webimage_extra_packages');
  });

  it('catches the alpine package manager with Debian advice', () => {
    expect(findDdevBuildBreakage(file('RUN apk add --no-cache curl'))).toContain('apt-get');
  });

  it('catches a helper buried in a chain', () => {
    expect(
      findDdevBuildBreakage(file('RUN apt-get update && docker-php-ext-enable redis')),
    ).toContain('docker-php-ext-enable');
  });

  it('passes a Dockerfile that uses the supported mechanism', () => {
    const text = [
      '# add the intl extension',
      'RUN apt-get update && apt-get install -y php${DDEV_PHP_VERSION}-intl',
    ].join('\n');
    expect(findDdevBuildBreakage(file(text))).toBeNull();
  });

  it('does not flag a command that merely appears as an argument', () => {
    expect(
      findDdevBuildBreakage(file('RUN echo "use docker-php-ext-install" > /tmp/note')),
    ).toBeNull();
  });

  it('does not treat an inherited Object property as a known-absent command', () => {
    expect(findDdevBuildBreakage(file('RUN constructor --version'))).toBeNull();
  });

  it('passes an empty input set', () => {
    expect(findDdevBuildBreakage([])).toBeNull();
  });
});

describe('findDdevSpecBreakage', () => {
  // Verbatim from the spec that deadlocked task 72ccb002 for twelve days.
  const PRESCRIBING_SPEC = [
    '### 1. `ext/mysql` — the hard blocker',
    '',
    '`.ddev/web-build/Dockerfile.example` confirms that this file is **appended** to DDEV’s own',
    'Dockerfile — no `FROM` line is needed or allowed.',
    '',
    '```dockerfile',
    '# .ddev/web-build/Dockerfile',
    'RUN docker-php-ext-install mysql',
    '```',
    '',
    'Do **not** use `apt-get install php5.6-mysql`.',
  ].join('\n');

  // The corrected spec: names the command three times to WARN against it, prescribes nothing.
  const WARNING_SPEC = [
    'DDEV installs `php5.6-mysql` automatically for `php_version: "5.6"`.',
    '',
    'Do **not** add `RUN docker-php-ext-install mysql` to a build Dockerfile: it fails the image',
    'build with "command not found" (exit 127) on every `ddev start`.',
    '',
    '### Q2: What is the correct way to get `ext/mysql`?',
    '- [ ] `RUN docker-php-ext-install mysql` in `.ddev/web-build/Dockerfile`',
    '- [x] Nothing — DDEV installs it automatically',
    '> Explanation: `docker-php-ext-install` is NOT available in `ddev/ddev-webserver`.',
  ].join('\n');

  it('flags a spec that prescribes the command in a fenced block', () => {
    const reason = findDdevSpecBreakage(PRESCRIBING_SPEC);
    expect(reason).toContain('docker-php-ext-install');
    expect(reason).toContain('webimage_extra_packages');
    // Not the runtime-failure prefix: a spec finding is not a bring-up failure.
    expect(reason).not.toContain(DDEV_BUILD_INPUT_PREFIX);
  });

  it('does NOT flag a spec that only warns against the command', () => {
    expect(findDdevSpecBreakage(WARNING_SPEC)).toBeNull();
  });

  it('ignores a fenced line that cannot fail the build', () => {
    expect(findDdevSpecBreakage('```sh\nRUN pecl install redis || true\n```')).toBeNull();
  });

  it('passes a spec with no fenced blocks at all', () => {
    expect(findDdevSpecBreakage('Just prose about docker-php-ext-install.')).toBeNull();
  });

  it('finds a prescription in any fence language, not just dockerfile', () => {
    expect(findDdevSpecBreakage('```\nRUN apk add curl\n```')).toContain('apt-get');
  });
});

describe('isBuildDockerfile', () => {
  it('accepts Dockerfile and its suffixed variants', () => {
    expect(isBuildDockerfile('Dockerfile')).toBe(true);
    expect(isBuildDockerfile('Dockerfile.drupal')).toBe(true);
  });

  it('rejects the inert sample and unrelated files', () => {
    expect(isBuildDockerfile('Dockerfile.example')).toBe(false);
    expect(isBuildDockerfile('README.txt')).toBe(false);
  });
});

describe('isDdevBuildInputFailure', () => {
  it('classifies a BuildKit step failure as the implementing agent to fix', () => {
    const output = [
      '#27 [web 16/18] RUN docker-php-ext-install mysql',
      '#27 0.353 /bin/bash: line 1: docker-php-ext-install: command not found',
      '#27 ERROR: process "/bin/bash -c docker-php-ext-install mysql" did not complete successfully: exit code: 127',
    ].join('\n');
    expect(isDdevBuildInputFailure(output)).toBe(true);
  });

  it('classifies our own pre-flight verdict', () => {
    const reason = findDdevBuildBreakage([
      { name: '.ddev/web-build/Dockerfile', content: 'RUN pecl install redis' },
    ]);
    expect(isDdevBuildInputFailure(`DDEV cannot start: ${reason}`)).toBe(true);
  });

  it('leaves a version-constraint rejection on the hard-fail path', () => {
    const output =
      'ddev start blocked by an incompatible ddev_version_constraint in .ddev/config.yaml. ' +
      "your DDEV version 'v1.25.3' doesn't meet the constraint '= v1.24.8'";
    expect(isDdevBuildInputFailure(output)).toBe(false);
  });

  it('leaves a healthcheck timeout on the hard-fail path', () => {
    expect(
      isDdevBuildInputFailure('ddev restart failed: web container failed to become ready'),
    ).toBe(false);
  });
});

describe('isDdevContainerConfigFailure', () => {
  // The line that killed task a0d1bbf9. It reaches the predicate only because
  // ddevFailureMessage captures the web container's log into the error — DDEV's own output
  // says nothing but "web container exited".
  const DUPLICATE_LOCATION =
    'ddev restart failed: Failed waiting for web/db containers to become ready: ' +
    'ddev-rs-codex-5-6-high-web container exited.\n\n--- DDEV web/db container logs ---\n' +
    'nginx: [emerg] duplicate location "/aliases.ser" in ' +
    '/mnt/ddev_config/nginx/rs-codex-5-6-high.conf:37';

  it('flags the real nginx failure that exited the web container', () => {
    expect(isDdevContainerConfigFailure(DUPLICATE_LOCATION)).toBe(true);
  });

  it('flags an apache config syntax error and a php-fpm config load failure', () => {
    expect(
      isDdevContainerConfigFailure(
        'AH00526: Syntax error on line 12 of /etc/apache2/sites-enabled/apache-site.conf',
      ),
    ).toBe(true);
    expect(
      isDdevContainerConfigFailure(
        "ERROR: failed to load configuration file '/etc/php/5.6/fpm/php-fpm.conf'",
      ),
    ).toBe(true);
  });

  it('leaves an nginx emerg the implementation cannot fix on the hard-fail path', () => {
    // A bound port is the host's problem; editing .ddev/ cannot resolve it, so looping the
    // implementation step would burn a round to reach the same failure.
    expect(
      isDdevContainerConfigFailure(
        'nginx: [emerg] bind() to 0.0.0.0:80 failed (98: Address already in use)',
      ),
    ).toBe(false);
  });

  it('does not fire on a healthy container log', () => {
    // Both lines are routine in a working project's log (observed on rs_codex_low).
    expect(
      isDdevContainerConfigFailure(
        'WARNING: [pool www] child 1797 said into stderr: "NOTICE: PHP message: ..."\n' +
          "AH01071: Got error 'PHP message: PHP Notice: Undefined variable: step ... on line 146'",
      ),
    ).toBe(false);
  });
});

describe('isDdevAgentFixableFailure', () => {
  it('covers build inputs, container config, and the nginx include guard', () => {
    expect(isDdevAgentFixableFailure('#27 ERROR: failed to solve: exit code 127')).toBe(true);
    expect(isDdevAgentFixableFailure('nginx: [emerg] unknown directive "locaton"')).toBe(true);

    const collision = findDdevNginxIncludeCollisions({
      siteConfs: [
        {
          name: 'rs.conf',
          content:
            'server {\n  location = /a {\n  }\n  include /mnt/ddev_config/nginx/*.conf;\n}\n',
        },
      ],
      snippets: [{ name: 'rs.conf', content: 'location = /a {\n}\n' }],
    });
    expect(isDdevAgentFixableFailure(`DDEV cannot start: ${collision}`)).toBe(true);
  });

  it('leaves host-level failures on the hard-fail path', () => {
    expect(isDdevAgentFixableFailure('Error response from daemon: No such container')).toBe(false);
    expect(
      isDdevAgentFixableFailure(
        "ddev start blocked by an incompatible ddev_version_constraint: your DDEV version 'v1.25.3'",
      ),
    ).toBe(false);
  });
});

// Task f33d410a ("Add DDEV" on rs_claude_haiku_max), 2026-08-07, verbatim shape. The web
// container exited inside the project's own entrypoint hook, which had chowned aliases.ser to
// www-data on an earlier boot and then bare-`touch`ed it on this one. Every branch that
// existed returned false, so 07c hard-failed at round 7 with fix rounds still available.
const ENTRYPOINT_ABORT =
  'ddev start failed: Waiting for containers to become ready: [web db]...\n' +
  'Failed waiting for web/db containers to become ready: ' +
  'ddev-rs-claude-haiku-max-web container exited.\n\n' +
  '--- DDEV web/db container logs ---\n' +
  '=== ddev-rs-claude-haiku-max-web ===\n' +
  'mnt/ddev_config/web-entrypoint.d/post-start.sh\n' +
  "++ '[' '!' -d /var/www/html/.ddev ']'\n" +
  '++ mkdir -p /var/www/html/UserFiles\n' +
  "chmod: changing permissions of '/var/www/html/UserFiles': Operation not permitted\n" +
  '++ touch /var/www/html/aliases.ser\n' +
  "touch: cannot touch '/var/www/html/aliases.ser': Permission denied\n" +
  '+ trap - SIGTERM\n' +
  '+ kill -- -1\n' +
  '=== ddev-rs-claude-haiku-max-db ===\n' +
  '2026-08-07 13:17:45 0 [Note] InnoDB: log sequence number 44776; transaction id 15\n' +
  '2026-08-07 13:17:45 0 [Note] mysqld: ready for connections.';

describe('isDdevEntrypointRuntimeFailure', () => {
  it('flags the entrypoint abort that hard-failed task f33d410a', () => {
    expect(isDdevEntrypointRuntimeFailure(ENTRYPOINT_ABORT)).toBe(true);
    expect(isDdevAgentFixableFailure(ENTRYPOINT_ABORT)).toBe(true);
  });

  it('needs all three signals — a container that exited is not enough on its own', () => {
    // An OOM-killed or reaped container exits too, and editing .ddev/ cannot fix that.
    expect(
      isDdevEntrypointRuntimeFailure(
        'Failed waiting for web/db containers to become ready: ddev-x-web container exited.',
      ),
    ).toBe(false);
    // The hook ran and the container exited, but nothing in it failed.
    expect(
      isDdevEntrypointRuntimeFailure(
        'ddev-x-web container exited.\n/mnt/ddev_config/web-entrypoint.d/post-start.sh\n+ echo ok',
      ),
    ).toBe(false);
    // A command failed, but no container exited — a readiness timeout, not an abort.
    expect(
      isDdevEntrypointRuntimeFailure(
        'web container is unhealthy\n/mnt/ddev_config/web-entrypoint.d/x.sh\nfoo: command not found',
      ),
    ).toBe(false);
  });
});

// Task 4ce9b4e1 ("Add DDEV" on rs_codex_5.6_max), 2026-08-09, verbatim shape. A post-start
// hook on the DB service exited 1, and `fail_on_hook_fail: true` turned that into a failed
// `ddev restart`. Every branch that existed returned false — hooks run scripts from wherever
// the agent put them (`.ddev/scripts/`), which no pre-flight guard reads — so 07c hard-failed
// the task at round 2 of its 5 fix rounds.
const HOOK_ABORT =
  'ddev restart failed: Waiting for containers to become ready: [web db]... ready in 7.0s\n' +
  'ddev-router already running, pushing new config...\n' +
  '[redsys-db-defaults] outcome=failure stage=startup-decision ' +
  'reason=failure-environment-unavailable schema=db table_count=0\n' +
  "Task failed: Exec command 'bash /mnt/ddev_config/scripts/ensure-legacy-db-defaults.sh' " +
  "in container/service 'db': exit status 1\n" +
  'Failed to restart rs-codex-5-6-max: task failed: exit status 1';

describe('isDdevHookFailure', () => {
  it('flags the post-start hook that hard-failed task 4ce9b4e1', () => {
    expect(isDdevHookFailure(HOOK_ABORT)).toBe(true);
    expect(isDdevAgentFixableFailure(HOOK_ABORT)).toBe(true);
  });

  it('flags an exec-host hook too', () => {
    expect(
      isDdevHookFailure(
        "Task failed: Exec command 'rm -f .ddev/.ready' on the host " +
          '(/var/lib/haive/repos/x): exit status 1',
      ),
    ).toBe(true);
  });

  it('needs both markers on one line', () => {
    // The description alone is how DDEV narrates a hook it is about to run.
    expect(
      isDdevHookFailure("Exec command 'bash /mnt/ddev_config/scripts/x.sh' in container/service"),
    ).toBe(false);
    // And a failure word from elsewhere in the blob must not adopt it.
    expect(
      isDdevHookFailure(
        'Failed to restart x: task failed: exit status 1\n' +
          "Exec command 'bash /mnt/ddev_config/scripts/x.sh' in container/service 'db'",
      ),
    ).toBe(false);
  });

  it('leaves host-level bring-up failures alone', () => {
    expect(isDdevHookFailure('ddev-x-web container exited.')).toBe(false);
    expect(
      isDdevHookFailure(
        "ddev start blocked by an incompatible ddev_version_constraint: your DDEV version 'v1.25.3'",
      ),
    ).toBe(false);
  });
});

describe('the host-level veto is scoped to the line that carries the config error', () => {
  it('no longer lets an unrelated Permission denied veto a real config error', () => {
    // Exactly what the captured entrypoint trace does: it puts "Permission denied" in the
    // message forty lines away from anything nginx said. Tested against the whole blob, that
    // vetoed the nginx emerg and sent an agent-fixable failure down the hard-fail path.
    const mixed =
      'ddev-x-web container exited.\n' +
      '--- DDEV web/db container logs ---\n' +
      "touch: cannot touch '/var/www/html/aliases.ser': Permission denied\n" +
      'nginx: [emerg] unknown directive "locaton" in /mnt/ddev_config/nginx/x.conf:12';
    expect(isDdevContainerConfigFailure(mixed)).toBe(true);
  });

  it('still keeps a bound port on the hard-fail path — both markers share one line', () => {
    expect(
      isDdevContainerConfigFailure(
        'ddev-x-web container exited.\n' +
          'nginx: [emerg] bind() to 0.0.0.0:80 failed (98: Address already in use)',
      ),
    ).toBe(false);
  });
});
