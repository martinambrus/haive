import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * No resource name may be typed at a call site.
 *
 * The naming module exists so that a container/volume/network/image/database name and the FILTER
 * a reaper deletes by are the same string, resolved once. A literal that slips back in produces
 * one of two failures and both are worse than the collision being fixed: a filter too narrow leaks
 * resources forever with nothing reporting it, and a filter too broad makes one install reap
 * another install's containers, volumes and databases.
 *
 * Source-level rather than behavioural, because the failure mode IS a literal in the source. A
 * behavioural test would have to run two installs against a real daemon to see it.
 */

const ROOTS = [
  fileURLToPath(new URL('../src', import.meta.url)),
  fileURLToPath(new URL('../../api/src', import.meta.url)),
  fileURLToPath(new URL('../../shared/src', import.meta.url)),
  // The updater was omitted at first, and a literal `haive-network` survived in it as a result:
  // its one-shot containers joined the DEFAULT install's network on a namespaced install. A guard
  // that does not read a package cannot protect it.
  fileURLToPath(new URL('../../updater/src', import.meta.url)),
];

/** The naming module is where the shape of a name is allowed to be written down. */
const OWNS_THE_SHAPE = ['shared/src/naming/'];

/**
 * Literals that are not Docker or Postgres resource names.
 *
 * Each is a different namespace that happens to share the prefix, and namespacing them would be
 * wrong rather than merely unnecessary: a queue name and a Redis key live inside this install's
 * own Redis, an env var and a label KEY are read by name across versions, and a temp directory is
 * on the host filesystem under a random uuid.
 */
const NOT_A_RESOURCE = [
  // BullMQ queue names. They live in THIS install's own Redis, which is already a separate
  // container per install, so namespacing them would change a key for no isolation gain.
  /haive-(?:cli-exec|task|env-replicate|repo|bundle|runtime-ensure|ide-ensure|ddev-control|usage-poll|pr-poll|plan-mirror|global-kb-sync|kb-author)\b/,
  // Service identity, user agents and a download filename: strings a human or an HTTP peer reads.
  /haive-(?:api|worker|web|cli-version-fetcher|ddev-rootCA)\b/,
  /HAIVE_[A-Z_]+/,
  /haive\.[a-z.]+/, // label KEYS and the haive.local hostname
  /haive-(?:env-build|sandbox-build|compose|net|dump|shots)-/, // host temp dirs
  /haive_(?:access|refresh)\b/, // cookie names
  /haive-(?:task|rag|mcp|chrome-mcp-proxy|price-sync|runtime-tools|worker|data|ide-ensure|api-|migrated-|import-|pre-migrate|pre-rename)/,
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      out.push(...sourceFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Strip comments — prose legitimately names `haive-cli-` when explaining what a filter matches. */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('resource names are never typed at a call site', () => {
  it('no source file outside the naming module contains a resource-name literal', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of sourceFiles(root)) {
        if (OWNS_THE_SHAPE.some((p) => file.replace(/\\/g, '/').includes(p))) continue;
        const lines = codeOnly(readFileSync(file, 'utf8')).split('\n');
        lines.forEach((line, i) => {
          // A Postgres advisory lock key is not a resource name. It is scoped to the DATABASE the
          // connection is on, and every install has its own Postgres, so the isolation the install
          // id would add is already there — namespacing it would change a key for no gain. Keyed
          // on the CALL rather than on the string's shape, because what makes it a lock key is
          // where it is passed, not what it is spelled.
          // `advisory` alone, not `advisory_lock`: the function this repo actually calls is
          // `pg_advisory_XACT_lock`, so the narrower string matches none of the call sites.
          if (line.includes('advisory')) return;
          const matches = line.match(/['"`]haive[-_][A-Za-z0-9_-]*/g);
          if (!matches) return;
          for (const m of matches) {
            const bare = m.slice(1);
            if (NOT_A_RESOURCE.some((re) => re.test(bare))) continue;
            offenders.push(`${file.split('/src/')[1]}:${i + 1}  ${line.trim().slice(0, 100)}`);
          }
        });
      }
    }
    expect(offenders, `typed resource names found:\n${offenders.join('\n')}`).toEqual([]);
  });
});
