import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDdevConfig } from '../step-engine/steps/_ddev-config.js';

/**
 * Pre-flight check that DDEV's own web healthcheck can still pass.
 *
 * `ddev-webserver`'s `/healthcheck.sh` gates the container on
 * `curl --fail -s 127.0.0.1/phpstatus` for any `*-fpm` webserver type, and DDEV's
 * generated vhost is what routes that path (`Alias "/phpstatus" "/var/www/phpstatus.php"`
 * on apache, a `location` block on nginx). An agent that took over the generated file —
 * stripping `#ddev-generated`, which permanently opts the file out of regeneration — and
 * dropped the alias leaves a project that can never boot again: the container sits in
 * `starting` until `ddev start` gives up at its readiness timeout, ~6 opaque minutes per
 * attempt, with nothing in the error naming the cause (task aba4d722, twice).
 *
 * Detecting it costs a couple of file reads, so it runs before every bring-up. No repair:
 * rewriting an agent's config behind its back trades one silent failure for another.
 */

/** The path DDEV generates its site config at, per webserver family. A file anywhere else
 *  in these directories is the user's own and is never regenerated. */
const GENERATED_SITE_CONF: Record<string, { dir: string; file: string; customAdvice: string }> = {
  apache: {
    dir: 'apache',
    file: 'apache-site.conf',
    // Apache loads every *.conf in the directory as its own vhost, so a sibling is the right
    // home for custom rules and cannot collide with the generated one.
    customAdvice: 'put any custom rules in a sibling file such as .ddev/apache/<project>.conf',
  },
  nginx: {
    dir: 'nginx_full',
    file: 'nginx-site.conf',
    // NOT a nginx_full sibling. That would be a second SERVER block, and DDEV splices every
    // `.ddev/nginx/*.conf` into it as well as into the generated one — so rules that end up
    // in both abort nginx with `[emerg] duplicate location` and the web container exits
    // (task a0d1bbf9, which followed this very sentence when it still said "sibling").
    // `.ddev/nginx/` is DDEV's own add-on point: included inside the generated server block,
    // applied exactly once. See ddev-nginx-include-guard.ts.
    customAdvice:
      'put any custom rules in .ddev/nginx/<project>.conf, which DDEV includes inside the ' +
      'generated server block (do NOT add a second server block in .ddev/nginx_full/)',
  },
};

const DDEV_GENERATED_MARKER = '#ddev-generated';
/** The endpoint /healthcheck.sh polls. Not the directive syntax — `Alias` / `AliasMatch` /
 *  a `location` variant are all legitimate ways to serve it. The path is the invariant. */
const HEALTHCHECK_PATH = '/phpstatus';
/** The two webserver families route /phpstatus by DIFFERENT mechanisms, verified against
 *  `ddev/ddev-webserver:v1.25.3`:
 *   - apache serves it ONLY from `/etc/apache2/sites-enabled/apache-site.conf`, the file
 *     DDEV copies out of `.ddev/apache/` — so the literal path must appear there.
 *   - nginx serves it from the image's own `/etc/nginx/monitoring.conf`, which
 *     `nginx.conf` does NOT include; the site conf pulls it in with
 *     `include /etc/nginx/monitoring.conf`. A stock `nginx-site.conf` therefore contains
 *     NO `/phpstatus` at all, and demanding one falsely condemns every nginx project
 *     (which is exactly what it did to rs_codex_5.6_high before this).
 *  Matching the include on the FILE NAME rather than the absolute path so a DDEV
 *  directory reshuffle degrades to "we stop recognising it", never to a false alarm. */
const NGINX_MONITORING_INCLUDE = 'monitoring.conf';

/** Tokens that prove a conf routes the healthcheck endpoint, per family. Either one is
 *  enough — this is deliberately lenient, because a false "broken" verdict blocks a
 *  working environment while a false "fine" only costs the readiness timeout we already
 *  had. */
function servesHealthcheck(family: string, text: string): boolean {
  if (text.includes(HEALTHCHECK_PATH)) return true;
  return family === 'nginx' && text.includes(NGINX_MONITORING_INCLUDE);
}

/** Strip full-line comments so a conf that merely mentions the endpoint in prose does not
 *  read as serving it. Deliberately does NOT try to parse directives: a false "broken"
 *  verdict blocks a working environment, while a false "fine" only returns us to today's
 *  behaviour, so the loose side is the safe side. */
function withoutComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/** True for the webserver types whose healthcheck requires /phpstatus, using the exact
 *  test /healthcheck.sh applies: `${DDEV_WEBSERVER_TYPE#*-}` = `fpm` — the substring after
 *  the FIRST dash. `generic` has no dash, so it stays `generic` and is exempt (the script
 *  returns early for it). An absent type means DDEV's default, `nginx-fpm`. */
export function webserverNeedsPhpStatus(webserverType: string | null | undefined): boolean {
  const type = webserverType?.trim() || 'nginx-fpm';
  const dash = type.indexOf('-');
  return (dash === -1 ? type : type.slice(dash + 1)) === 'fpm';
}

export interface DdevSiteConf {
  /** File name within the webserver config directory, e.g. `apache-site.conf`. */
  name: string;
  content: string;
}

/**
 * Reason the next `ddev start` will hang on its web healthcheck, or null when it will not.
 *
 * Breakage requires all of:
 *  - an fpm webserver type (otherwise /phpstatus is never polled);
 *  - the generated site conf present AND no longer carrying `#ddev-generated` — with the
 *    marker DDEV rewrites it at start, and an absent file is created from scratch, so in
 *    both cases the alias comes back on its own;
 *  - no active `*.conf` in the directory serving the endpoint (a sibling conf may
 *    legitimately provide it, which is exactly the customization pattern we recommend).
 */
export function findDdevHealthcheckBreakage(input: {
  webserverType: string | null | undefined;
  confs: DdevSiteConf[];
}): string | null {
  if (!webserverNeedsPhpStatus(input.webserverType)) return null;

  const family = (input.webserverType?.trim() || 'nginx-fpm').split('-')[0]!;
  const generated = GENERATED_SITE_CONF[family];
  if (!generated) return null;

  const active = input.confs.filter((c) => c.name.endsWith('.conf'));
  const site = active.find((c) => c.name === generated.file);
  // Absent, or still DDEV's to rewrite: the next start restores the alias itself.
  if (!site || site.content.includes(DDEV_GENERATED_MARKER)) return null;

  if (active.some((c) => servesHealthcheck(family, withoutComments(c.content)))) return null;

  return (
    `.ddev/${generated.dir}/${generated.file} was taken over (its \`${DDEV_GENERATED_MARKER}\` marker ` +
    `was removed) and no config in .ddev/${generated.dir}/ serves \`${HEALTHCHECK_PATH}\`. ` +
    `DDEV's web container health check requests that path on every start, so it will never ` +
    `become healthy and \`ddev start\` will fail at its readiness timeout. ` +
    `Fix: delete .ddev/${generated.dir}/${generated.file} so DDEV regenerates it, and ` +
    `${generated.customAdvice}.`
  );
}

/**
 * Read the workspace and apply {@link findDdevHealthcheckBreakage}.
 *
 * Returns null when nothing is wrong, when there is no `.ddev/`, or when the tree cannot
 * be read — an unreadable workspace is the boot's problem to report, not this check's.
 */
export async function checkDdevHealthcheckConfig(workspace: string): Promise<string | null> {
  const configText = await readFile(path.join(workspace, '.ddev', 'config.yaml'), 'utf8').catch(
    () => null,
  );
  if (configText === null) return null;

  const webserverType = parseDdevConfig(configText).webserver;
  if (!webserverNeedsPhpStatus(webserverType)) return null;

  const family = (webserverType?.trim() || 'nginx-fpm').split('-')[0]!;
  const generated = GENERATED_SITE_CONF[family];
  if (!generated) return null;

  const dir = path.join(workspace, '.ddev', generated.dir);
  const names = await readdir(dir).catch(() => null);
  if (names === null) return null;

  const confs: DdevSiteConf[] = [];
  for (const name of names.filter((n) => n.endsWith('.conf'))) {
    const content = await readFile(path.join(dir, name), 'utf8').catch(() => null);
    if (content !== null) confs.push({ name, content });
  }
  return findDdevHealthcheckBreakage({ webserverType, confs });
}
