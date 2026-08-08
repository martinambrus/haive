import { describe, expect, it } from 'vitest';
import {
  DDEV_CONFIG_YAML_PREFIX,
  findDdevYamlBreakage,
  isDdevParsedYaml,
} from './ddev-config-yaml-guard.js';

// The real `.ddev/config.yaml` from task fcf03ead (repo rs_muse_spark_1.2_low), written by
// the round-3 implementation agent. DDEV rejected it with `go-yaml load error in scanner at
// L14.C143: mapping values are not allowed in this context` — column 143 is the `:` inside
// `'WARN: chmod failed'`, which opens a nested mapping because the plain scalar started back
// at `chmod` and the single quotes are therefore literal characters.
const BROKEN = `# docroot must remain unset — RS_WORKING_DIR derived from __FILE__ in index.php:121
name: rs-muse-spark-1-2-low
type: php
php_version: "5.6"
webserver_type: apache-fpm
database:
  type: mariadb
  version: "10.11"
host_db_port: "32607"
hooks:
  post-start:
    - exec: cp -n .ddev/init.php.example init.php
    - exec: mkdir -p formphotos modsData UserFiles/File
    - exec: chmod 0755 aliases.ser formphotos || (echo 'WARN: chmod failed' >&2; true)
    - exec: chown -R www-data:www-data aliases.ser || (echo 'WARN: chown failed' >&2; true)
`;

// The same file with the two commands quoted — the fix the guard's message prescribes.
const FIXED = BROKEN.replace(
  /^ {4}- exec: (chmod .*|chown .*)$/gm,
  (_line, cmd: string) => `    - exec: "${cmd}"`,
);

describe('findDdevYamlBreakage', () => {
  it('flags the unquoted shell command that killed task fcf03ead', () => {
    const found = findDdevYamlBreakage([{ name: 'config.yaml', content: BROKEN }]);
    expect(found).toContain(DDEV_CONFIG_YAML_PREFIX);
    expect(found).toContain('.ddev/config.yaml');
    expect(found).toContain('line 14');
    // The message has to instruct, not just diagnose — it is the fix agent's prior error.
    expect(found).toContain('Wrap the whole command in double quotes');
  });

  it('passes the same file once the commands are quoted', () => {
    expect(FIXED).toContain(`- exec: "chmod 0755 aliases.ser formphotos || (echo 'WARN:`);
    expect(findDdevYamlBreakage([{ name: 'config.yaml', content: FIXED }])).toBeNull();
  });

  it('passes a config whose only colons are in comments and quoted scalars', () => {
    const ok = 'name: app\n# see index.php:121\nweb_environment:\n  - "A=1: ok"\n';
    expect(findDdevYamlBreakage([{ name: 'config.yaml', content: ok }])).toBeNull();
  });

  it('ignores errors go-yaml and this parser do not agree on', () => {
    // Duplicate keys and multi-document streams are accepted, rejected or first-wins
    // depending on the library. Flagging one would block an environment that boots.
    expect(
      findDdevYamlBreakage([{ name: 'config.yaml', content: 'name: a\nname: b\n' }]),
    ).toBeNull();
    expect(
      findDdevYamlBreakage([{ name: 'config.yaml', content: 'name: a\n---\nname: b\n' }]),
    ).toBeNull();
  });

  it('flags a tab used as indentation', () => {
    const tabbed = 'name: app\nhooks:\n\tpost-start:\n';
    expect(findDdevYamlBreakage([{ name: 'config.yaml', content: tabbed }])).toContain(
      DDEV_CONFIG_YAML_PREFIX,
    );
  });

  it('reports the first broken file and skips the valid ones', () => {
    const found = findDdevYamlBreakage([
      { name: 'config.yaml', content: 'name: app\n' },
      { name: 'config.local.yaml', content: BROKEN },
    ]);
    expect(found).toContain('.ddev/config.local.yaml');
  });

  it('returns null when there is nothing to parse', () => {
    expect(findDdevYamlBreakage([])).toBeNull();
  });
});

describe('isDdevParsedYaml', () => {
  it('matches the files DDEV loads at start', () => {
    expect(isDdevParsedYaml('config.yaml')).toBe(true);
    expect(isDdevParsedYaml('config.local.yaml')).toBe(true);
    expect(isDdevParsedYaml('docker-compose.mailhog.yaml')).toBe(true);
  });

  it("leaves DDEV's own generated compose files and everything else alone", () => {
    // Generated, and valid by construction — the leading dot is what keeps them out.
    expect(isDdevParsedYaml('.ddev-docker-compose-base.yaml')).toBe(false);
    expect(isDdevParsedYaml('.ddev-docker-compose-full.yaml')).toBe(false);
    // Not one of DDEV's globs: `docker-compose.*.yaml` needs a middle segment.
    expect(isDdevParsedYaml('docker-compose.yaml')).toBe(false);
    expect(isDdevParsedYaml('config.yaml.example')).toBe(false);
    expect(isDdevParsedYaml('nginx-site.conf')).toBe(false);
  });
});
