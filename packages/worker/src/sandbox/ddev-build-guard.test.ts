import { describe, expect, it } from 'vitest';
import {
  dockerfileRunCommands,
  findDdevBuildBreakage,
  isBuildDockerfile,
  isDdevBuildInputFailure,
} from './ddev-build-guard.js';

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
