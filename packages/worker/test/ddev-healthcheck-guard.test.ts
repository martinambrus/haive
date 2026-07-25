import { describe, expect, it } from 'vitest';
import {
  findDdevHealthcheckBreakage,
  webserverNeedsPhpStatus,
} from '../src/sandbox/ddev-healthcheck-guard.js';

// The file rs_codex_low's implement pass wrote: the `#ddev-generated` marker stripped
// (so DDEV will never regenerate it) and BOTH `Alias "/phpstatus"` blocks deleted. Every
// `ddev start` after it failed on the web container's health check.
const BROKEN_APACHE_SITE = `# ddev generic/default/php config for apache2

# See https://docs.ddev.com/en/stable/users/extend/customization-extendibility/#custom-apache-configuration
<VirtualHost *:80>
    ServerAdmin webmaster@localhost
    DocumentRoot /var/www/html
    ErrorLog /dev/stdout
    CustomLog /dev/stdout combined

    # Increase allowed field size for large cookies header.
    LimitRequestFieldSize 16380

</VirtualHost>
`;

// The same file in the sibling clone rs_codex_5.6_ultra, which boots fine.
const WORKING_APACHE_SITE = `# ddev generic/default/php config for apache2

#ddev-generated
# If you want to take over this file and customize it, remove the line above
<VirtualHost *:80>
    ServerAdmin webmaster@localhost
    DocumentRoot /var/www/html

    # Simple ddev technique to get a phpstatus
    Alias "/phpstatus" "/var/www/phpstatus.php"
    Alias "/xhprof" "/var/xhprof/xhprof_html"
</VirtualHost>
`;

// What rs_codex_5.6_ultra actually did with its custom rules — a sibling file, which is
// the pattern the boundary prompt recommends.
const SIBLING_CUSTOM_CONF = `<LocationMatch "^/(UserFiles|formphotos)/">
    RemoveHandler .php
</LocationMatch>
`;

describe('webserverNeedsPhpStatus', () => {
  it('matches the exact test /healthcheck.sh applies (substring after the FIRST dash)', () => {
    expect(webserverNeedsPhpStatus('apache-fpm')).toBe(true);
    expect(webserverNeedsPhpStatus('nginx-fpm')).toBe(true);
    // `generic` has no dash, so the shell expansion leaves it unchanged and the script
    // returns before ever polling /phpstatus.
    expect(webserverNeedsPhpStatus('generic')).toBe(false);
  });

  it('treats an absent type as DDEV’s nginx-fpm default', () => {
    expect(webserverNeedsPhpStatus(null)).toBe(true);
    expect(webserverNeedsPhpStatus(undefined)).toBe(true);
    expect(webserverNeedsPhpStatus('  ')).toBe(true);
  });
});

describe('findDdevHealthcheckBreakage', () => {
  it('flags the real rs_codex_low file that broke the environment', () => {
    const reason = findDdevHealthcheckBreakage({
      webserverType: 'apache-fpm',
      confs: [{ name: 'apache-site.conf', content: BROKEN_APACHE_SITE }],
    });
    expect(reason).toContain('apache-site.conf');
    expect(reason).toContain('/phpstatus');
    expect(reason).toContain('delete');
  });

  it('passes the real rs_codex_5.6_ultra file that boots fine', () => {
    expect(
      findDdevHealthcheckBreakage({
        webserverType: 'apache-fpm',
        confs: [{ name: 'apache-site.conf', content: WORKING_APACHE_SITE }],
      }),
    ).toBeNull();
  });

  it('passes when the marker survives even if the alias is momentarily absent', () => {
    // DDEV rewrites a marker-carrying file on every start, so its current bytes do not
    // decide the outcome — flagging it would block a boot that would have fixed itself.
    expect(
      findDdevHealthcheckBreakage({
        webserverType: 'apache-fpm',
        confs: [
          {
            name: 'apache-site.conf',
            content: `#ddev-generated\n<VirtualHost *:80>\n</VirtualHost>\n`,
          },
        ],
      }),
    ).toBeNull();
  });

  it('passes when the generated file is absent entirely', () => {
    // A fresh project: DDEV creates apache-site.conf, complete with the alias, at start.
    expect(
      findDdevHealthcheckBreakage({
        webserverType: 'apache-fpm',
        confs: [{ name: 'redaction-system.conf', content: SIBLING_CUSTOM_CONF }],
      }),
    ).toBeNull();
  });

  it('passes when a sibling conf provides the endpoint', () => {
    // Apache loads every *.conf in the directory, so the recommended customization
    // pattern can legitimately supply the endpoint the generated file lost.
    expect(
      findDdevHealthcheckBreakage({
        webserverType: 'apache-fpm',
        confs: [
          { name: 'apache-site.conf', content: BROKEN_APACHE_SITE },
          { name: 'health.conf', content: 'Alias "/phpstatus" "/var/www/phpstatus.php"\n' },
        ],
      }),
    ).toBeNull();
  });

  it('does not count the endpoint mentioned only in a comment', () => {
    expect(
      findDdevHealthcheckBreakage({
        webserverType: 'apache-fpm',
        confs: [
          { name: 'apache-site.conf', content: BROKEN_APACHE_SITE },
          { name: 'notes.conf', content: '# we removed the /phpstatus alias on purpose\n' },
        ],
      }),
    ).not.toBeNull();
  });

  it('ignores non-.conf files, which apache never loads', () => {
    expect(
      findDdevHealthcheckBreakage({
        webserverType: 'apache-fpm',
        confs: [
          { name: 'apache-site.conf', content: BROKEN_APACHE_SITE },
          {
            name: 'seconddocroot.conf.example',
            content: 'Alias "/phpstatus" "/var/www/phpstatus.php"\n',
          },
        ],
      }),
    ).not.toBeNull();
  });

  it('exempts a non-fpm webserver', () => {
    expect(
      findDdevHealthcheckBreakage({
        webserverType: 'generic',
        confs: [{ name: 'apache-site.conf', content: BROKEN_APACHE_SITE }],
      }),
    ).toBeNull();
  });

  it('checks nginx projects against their own generated file', () => {
    const broken = findDdevHealthcheckBreakage({
      webserverType: 'nginx-fpm',
      confs: [{ name: 'nginx-site.conf', content: 'server {\n  root /var/www/html;\n}\n' }],
    });
    expect(broken).toContain('nginx-site.conf');
    expect(broken).toContain('nginx_full');

    expect(
      findDdevHealthcheckBreakage({
        webserverType: 'nginx-fpm',
        confs: [
          {
            name: 'nginx-site.conf',
            content:
              'server {\n  location = /phpstatus {\n    fastcgi_pass 127.0.0.1:9000;\n  }\n}\n',
          },
        ],
      }),
    ).toBeNull();
  });
});
