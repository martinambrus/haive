import { describe, expect, it } from 'vitest';
import {
  dockerfileRunCommands,
  findDdevBuildBreakage,
  isBuildDockerfile,
  isDdevAgentFixableFailure,
  isDdevBuildInputFailure,
  isDdevContainerConfigFailure,
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
