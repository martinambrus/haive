import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bareFilenameCandidates } from '../src/step-engine/steps/kb-author/_citation-scrub.js';
import { bodyUsesRepoSymbol } from '../src/step-engine/steps/onboarding/08-knowledge-acquisition.js';
import { STACK_INDICATORS } from '../src/step-engine/steps/onboarding/01-env-detect.js';
import { ECOSYSTEM_FILENAMES } from '../src/step-engine/steps/kb-author/_citation-scrub.js';
import {
  citationCandidates,
  resolveInsideRepo,
  scrubCitations,
  splitIntoBlocks,
} from '../src/step-engine/steps/kb-author/_citation-scrub.js';

// A global KB article is retrieved by OTHER projects, so a path from the codebase that happened
// to be open is noise there and rots here. MEASURED on entry b15eebfb, which led with
// `sites/all/themes/activit/img/` and cited `internal_menu_block.tpl.php:83-88`.
let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), 'haive-scrub-'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true }).catch(() => {});
});

const mk = async (rel: string) => {
  await mkdir(path.join(repo, path.dirname(rel)), { recursive: true });
  await writeFile(path.join(repo, rel), 'x');
};

describe('splitIntoBlocks', () => {
  it('keeps a fenced example whole, so half a sample is never left behind', () => {
    const blocks = splitIntoBlocks('intro\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nafter');
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toBe('```js\nconst a = 1;\n\nconst b = 2;\n```');
  });
});

describe('scrubCitations', () => {
  it('removes a bare line reference that RESOLVES in the anchor repo', async () => {
    // A bare `name.ext:83-88` cannot be told apart from `host:port-port` by shape, so the repo
    // is what settles it. Anchored, the real citation resolves and the block goes.
    await mk('internal_menu_block.tpl.php');
    const body =
      '## The rule\n\nAlways X.\n\nSee internal_menu_block.tpl.php:83-88 for the bad case.';
    const r = await scrubCitations(body, { repoPath: repo });
    expect(r.body).not.toMatch(/83-88/);
    expect(r.body).toMatch(/Always X/);
    expect(r.removed[0]?.reason).toBe('internal_menu_block.tpl.php:83-88');
  });

  it('removes a path that RESOLVES in the anchor repo', async () => {
    await mk('sites/all/themes/activit/img/icon.png');
    const body =
      '## The rule\n\nUse files.\n\nThe convention is sites/all/themes/activit/img/ already.';
    const r = await scrubCitations(body, { repoPath: repo });
    expect(r.body).toMatch(/Use files/);
    expect(r.body).not.toMatch(/activit/);
    expect(r.removed).toHaveLength(1);
  });

  it('leaves an INVENTED example path alone — the whole point of verifying', async () => {
    // The prompt now asks for abstracted examples, which are full of plausible paths. A
    // shape-matching rule would delete exactly what we asked the model to write.
    const body =
      '## The right way\n\n```css\n.icon { background-image: url("/images/icon.svg"); }\n```\n\nPut it in src/components/Button.tsx.';
    const r = await scrubCitations(body, { repoPath: repo });
    expect(r.removed).toHaveLength(0);
    expect(r.body).toMatch(/Button\.tsx/);
    expect(r.body).toMatch(/icon\.svg/);
  });

  it('drops the whole block, not the sentence, so no claim outlives its evidence', async () => {
    await mk('web/modules/custom/acme/acme.module');
    const body =
      '## A\n\nkeep me\n\nThe helper lives in web/modules/custom/acme/acme.module and is cached.';
    const r = await scrubCitations(body, { repoPath: repo });
    expect(r.body).toBe('## A\n\nkeep me');
    expect(r.removed[0]?.excerpt).toMatch(/The helper lives in/);
  });

  it('removes a block leaning on a symbol defined in the anchor repo', async () => {
    const body = '## A\n\ngeneric advice\n\nCall activit_build_menu() first.';
    const r = await scrubCitations(body, {
      repoPath: repo,
      repoSymbols: new Set(['activit_build_menu']),
      findSymbol: (text, symbols) => [...symbols].find((s) => text.includes(s)) ?? null,
    });
    expect(r.body).toBe('## A\n\ngeneric advice');
    expect(r.removed[0]?.reason).toBe('activit_build_menu');
  });

  it('scrubs nothing from an article that was written correctly', async () => {
    await mk('sites/all/themes/activit/img/icon.png');
    const body =
      '## The rule\n\nReference SVG by URL.\n\n## The wrong way\n\n```html\n<!-- ANTI-PATTERN — do not copy -->\n<svg viewBox="0 0 16 16">...</svg>\n```\n\n## The right way\n\n```html\n<img src="/img/icon.svg" alt="">\n```';
    const r = await scrubCitations(body, { repoPath: repo });
    expect(r.removed).toEqual([]);
    expect(r.body).toBe(body);
  });
});

describe('citationCandidates', () => {
  it('ignores prose slashes and URLs that are not paths', () => {
    expect(citationCandidates('use and/or, see https://example.com/docs/x')).toEqual([]);
  });
});

// `activit.module:534` and `api.internal:8080` are the same token shape, so the shape alone
// cannot decide. Stripping on shape deleted whole blocks for naming a host and a port.
describe('line references vs host:port', () => {
  it('does NOT treat a range as proof — a port range is ordinary prose', async () => {
    // `db.example.com:8000-9000` and `internal_menu_block.tpl.php:83-88` are the same shape.
    // Treating a range as settling it deleted the block a networking rule was written in.
    const r = await scrubCitations('Listen on db.example.com:8000-9000 behind the proxy.', {
      repoPath: null,
    });
    expect(r.removed).toEqual([]);
    expect(r.body).toMatch(/8000-9000/);
  });

  it('strips a slashed path reference in either mode', async () => {
    const r = await scrubCitations('See src/Cache/Backend.php:12 here.', { repoPath: null });
    expect(r.removed).toHaveLength(1);
  });

  it('keeps a host and port, which is not a file reference', async () => {
    const body = [
      'Point the app at db.example.com:5432 and the cache at api.internal:8080.',
      '',
      'A queue at redis://cache.local:6379/0 behaves the same way.',
    ].join('\n');
    const r = await scrubCitations(body, { repoPath: null });
    expect(r.removed).toEqual([]);
    expect(r.body).toContain('db.example.com:5432');
    expect(r.body).toContain('redis://cache.local:6379/0');
  });

  it('strips a bare reference only when it resolves in the anchor repo', async () => {
    const kept = await scrubCitations('Handled in api.internal:8080 today.', {
      repoPath: '/nonexistent-repo-root',
    });
    expect(kept.removed).toEqual([]);
  });
});

// A citation is by definition something IN the repository, so a token resolving outside it is
// not one. Probing it anyway made any article that SHOWS a traversal example a false positive:
// `../../../../../../etc/passwd` joins to `/etc/passwd`, which exists on the worker.
describe('path probes stay inside the anchor repo', () => {
  it('rejects a traversal candidate instead of probing it', () => {
    expect(
      resolveInsideRepo('/var/lib/haive/repos/u/r', '../../../../../../etc/passwd'),
    ).toBeNull();
  });

  it('rejects a sibling directory that merely shares the prefix', () => {
    expect(resolveInsideRepo('/repos/app', '../app-backup/secrets.env')).toBeNull();
  });

  it('accepts an ordinary repo-relative path', () => {
    expect(resolveInsideRepo('/repos/app', 'src/Cache/Backend.php')).toBe(
      '/repos/app/src/Cache/Backend.php',
    );
  });

  it('keeps a block that only shows a traversal example', async () => {
    const r = await scrubCitations(
      'Never accept a user path like ../../../../../../etc/passwd in a download handler.',
      { repoPath: '/var/lib/haive/repos/u/r' },
    );
    expect(r.removed).toEqual([]);
  });
});

// An agent that cites what it read often writes the CONTAINER path it saw. The path pattern
// could not start a capture on `/`, so an absolute sandbox path produced no candidate at all
// and walked straight through the scrub.
describe('absolute sandbox paths', () => {
  it('strips a citation written as the sandbox path', async () => {
    await mk('src/private-helper.ts');
    const r = await scrubCitations('Handled in /haive/workdir/src/private-helper.ts today.', {
      repoPath: repo,
    });
    expect(r.removed).toHaveLength(1);
  });

  it('leaves an absolute path that is not the workdir alone', async () => {
    // Belongs to no repository, and resolveInsideRepo would reject it anyway — but it must not
    // even become a candidate, or an article about file permissions loses a block.
    const r = await scrubCitations('Never expose /etc/ssl/private/server.key in a build.', {
      repoPath: repo,
    });
    expect(r.removed).toEqual([]);
  });
});

// A bare filename has no slash and no line number, so neither pattern saw it — while the
// authoring contract forbids filenames as well as paths, and an anchored model that has just
// read the tree reaches for them naturally.
describe('bare repository filenames', () => {
  it('strips one that exists at the anchor repo root', async () => {
    await mk('acme.config.ts');
    const r = await scrubCitations('The rule lives in acme.config.ts for this project.', {
      repoPath: repo,
    });
    expect(r.removed).toHaveLength(1);
    expect(r.removed[0]?.reason).toBe('acme.config.ts');
  });

  it('keeps an ecosystem filename even though it resolves', async () => {
    // `composer.json` sits at the root of the anchor repo AND shares its shape with the case
    // above, so only the exemption separates them. "Declare it in composer.json" is exactly the
    // generic advice a house rule is supposed to contain.
    await mk('composer.json');
    const r = await scrubCitations('Declare the dependency in composer.json as usual.', {
      repoPath: repo,
    });
    expect(r.removed).toEqual([]);
  });

  it('keeps an invented filename that resolves nowhere', async () => {
    const r = await scrubCitations('Something like acme.invented.ts would hold it.', {
      repoPath: repo,
    });
    expect(r.removed).toEqual([]);
  });

  it('keeps bare filenames on a repo-less run, which has nothing to check against', async () => {
    const r = await scrubCitations('The rule lives in acme.config.ts for this project.', {
      repoPath: null,
    });
    expect(r.removed).toEqual([]);
  });
});

// A repo-defined TYPE is not called, it is constructed — Go/Rust write `InvoiceRow{...}` and
// Elixir `%InvoiceRow{...}` — so collecting those names bought nothing until the matcher learned
// the literal form. Kept to `[ \t]*` so a markdown heading above an unrelated block cannot match.
describe('bodyUsesRepoSymbol type literals', () => {
  const symbols = new Set(['InvoiceRow', 'process_invoice']);

  it('matches a struct literal', () => {
    expect(bodyUsesRepoSymbol('row := InvoiceRow{ID: 1}', symbols)).toBe('InvoiceRow');
    expect(bodyUsesRepoSymbol('let r = InvoiceRow { id: 1 };', symbols)).toBe('InvoiceRow');
    expect(bodyUsesRepoSymbol('%InvoiceRow{id: 1}', symbols)).toBe('InvoiceRow');
  });

  it('still matches the forms it always did', () => {
    expect(bodyUsesRepoSymbol('process_invoice(x)', symbols)).toBe('process_invoice');
    expect(bodyUsesRepoSymbol('new InvoiceRow', symbols)).toBe('InvoiceRow');
    expect(bodyUsesRepoSymbol('InvoiceRow::new()', symbols)).toBe('InvoiceRow');
  });

  it('does not cross a newline to reach a brace', () => {
    // `## InvoiceRow` followed by an unrelated fenced block is a heading, not a literal.
    expect(bodyUsesRepoSymbol('## InvoiceRow\n\n{ "a": 1 }', symbols)).toBeNull();
  });

  it('ignores a name this repo does not define', () => {
    expect(bodyUsesRepoSymbol('OtherThing{x: 1}', symbols)).toBeNull();
  });

  it('matches a Ruby/Elixir bang or predicate call', () => {
    // The declaration scanner captures the BASE word — its pattern stops at the punctuation —
    // so the set holds `process_invoice` while the article writes `process_invoice!(...)`.
    // Requiring `(` straight after the base word missed the idiomatic form in both languages.
    expect(bodyUsesRepoSymbol('process_invoice!(invoice)', symbols)).toBe('process_invoice');
    expect(bodyUsesRepoSymbol('if process_invoice?(invoice) do', symbols)).toBe('process_invoice');
    // Still not a match without a call: a bare mention is not a citation of the code.
    expect(bodyUsesRepoSymbol('the process_invoice! helper', symbols)).toBeNull();
  });

  it('matches a qualified setter assignment, and nothing that only looks like one', () => {
    // Ruby declares `def invoice_total=(value)`, which the scanner records as `invoice_total`, and
    // calls it only as an assignment through a receiver: there is no parenthesis to match.
    const setters = new Set(['invoice_total']);
    expect(bodyUsesRepoSymbol('processor.invoice_total = value', setters)).toBe('invoice_total');
    expect(bodyUsesRepoSymbol('self.invoice_total = value', setters)).toBe('invoice_total');
    expect(bodyUsesRepoSymbol('processor.invoice_total ||= compute', setters)).toBe(
      'invoice_total',
    );
    // A bare assignment is a local variable (PHP's `$` included); the rest compare or build a hash.
    expect(bodyUsesRepoSymbol('invoice_total = value', setters)).toBeNull();
    expect(bodyUsesRepoSymbol('$invoice_total = value', setters)).toBeNull();
    expect(bodyUsesRepoSymbol('processor.invoice_total == value', setters)).toBeNull();
    expect(bodyUsesRepoSymbol('processor.invoice_total =~ /x+/', setters)).toBeNull();
    expect(bodyUsesRepoSymbol('{ processor.invoice_total => value }', setters)).toBeNull();
  });

  it('matches a Ruby postfix constructor call', () => {
    // Ruby constructs with `InvoiceProcessor.new(order)`: the call arm sees only the too-short
    // `new`, and the `new` arm reads the prefix form other languages use.
    const classes = new Set(['InvoiceProcessor']);
    expect(bodyUsesRepoSymbol('InvoiceProcessor.new(order)', classes)).toBe('InvoiceProcessor');
    expect(bodyUsesRepoSymbol('processor = Billing::InvoiceProcessor.new', classes)).toBe(
      'InvoiceProcessor',
    );
    // A method that merely starts with `new`, and a bare mention, are not constructor calls.
    expect(bodyUsesRepoSymbol('InvoiceProcessor.new_record?', classes)).toBeNull();
    expect(bodyUsesRepoSymbol('the InvoiceProcessor class', classes)).toBeNull();
  });
});

// The bare-filename rule resolved at the repo ROOT only, so `InvoiceProcessor.ts` living under
// `src/` slipped through — the slashed-path rule cannot see it either, a bare name having no
// separator to match on. Widening it to the whole tree is only safe with the distinctiveness
// gate: matching every basename would delete a block for saying `config.php`.
describe('scrubCitations bare filenames outside the repo root', () => {
  const opts = (basenames: string[]) => ({
    repoPath: '/nonexistent-repo-root',
    repoBasenames: new Set(basenames),
  });

  it('removes a DISTINCTIVE filename found anywhere in the tree', async () => {
    const res = await scrubCitations(
      'Register the handler in InvoiceProcessor.ts before dispatch.',
      opts(['invoiceprocessor.ts']),
    );
    expect(res.removed).toHaveLength(1);
    expect(res.removed[0]?.reason).toBe('InvoiceProcessor.ts');
  });

  it('keeps a GENERIC filename even when the repo has one', async () => {
    // `config.php` belongs to no repository in particular and turns up in invented examples
    // constantly. Deleting a block for it is the over-removal this scrub must never commit.
    const res = await scrubCitations(
      'Put the constant in config.php and reload.',
      opts(['config.php']),
    );
    expect(res.removed).toHaveLength(0);
  });

  it('keeps a distinctive filename this repo does not have', async () => {
    const res = await scrubCitations(
      'See InvoiceProcessor.ts for the shape.',
      opts(['other_thing.ts']),
    );
    expect(res.removed).toHaveLength(0);
  });

  it('removes a KEBAB-CASE filename, which is how most source files are actually named', async () => {
    // The first version of this gate reused `isDistinctiveSymbol`, and a SYMBOL cannot contain a
    // hyphen — so the single most common real filename shape was the one it could not see.
    const res = await scrubCitations(
      'Register the handler in invoice-processor.ts before dispatch.',
      opts(['invoice-processor.ts']),
    );
    expect(res.removed).toHaveLength(1);
    expect(res.removed[0]?.reason).toBe('invoice-processor.ts');
  });

  it('still keeps a single-word stem however it is written', async () => {
    for (const name of ['config.php', 'index.php', 'utils.ts']) {
      const res = await scrubCitations(`Put it in ${name} and reload.`, opts([name.toLowerCase()]));
      expect(res.removed).toHaveLength(0);
    }
  });

  it('behaves exactly as before when no basename index is supplied', async () => {
    const res = await scrubCitations('Register it in InvoiceProcessor.ts first.', {
      repoPath: '/nonexistent-repo-root',
    });
    expect(res.removed).toHaveLength(0);
  });
});

// Every stack marker the detector knows must be exempt, or the ROOT lookup resolves it and
// deletes the block: "configure this in pom.xml" is reusable advice about Maven, not a citation
// of somebody's repository. The two lists drifted apart the moment the symbol scan grew a
// language, so the relationship is asserted rather than maintained by hand.
describe('ecosystem manifest exemptions', () => {
  it('exempts every manifest the stack detector recognises', () => {
    const markers = [...new Set(STACK_INDICATORS.map((i) => i.file.toLowerCase()))].sort();
    const missing = markers.filter((m) => !ECOSYSTEM_FILENAMES.has(m));
    expect(missing).toEqual([]);
  });

  // A workspace or lock file of an exempt ecosystem is the same vocabulary as its manifest, and it
  // lives at the repo ROOT, where the lookup resolves it and deletes the block. "Commit
  // go.work.sum" is reusable Go guidance exactly as "commit go.sum" already was. Passed as
  // `repoBasenames` too, as 01-enrich does: `pnpm-workspace.yaml` has a hyphenated stem, which
  // reads as distinctive and is removed wherever it resolves.
  it('keeps workspace and lockfile advice for exempt ecosystems', async () => {
    for (const name of ['go.work', 'go.work.sum', 'bun.lock', 'pnpm-workspace.yaml']) {
      await mk(name);
      const body = `## The rule\n\nKeep ${name} committed so every checkout resolves the same dependencies.`;
      const r = await scrubCitations(body, { repoPath: repo, repoBasenames: new Set([name]) });
      expect(
        r.removed.map((b) => b.reason),
        name,
      ).toEqual([]);
      expect(r.body, name).toContain(name);
    }
  });
});

// The `{2,8}` extension floor exists to keep prose out — `e.g`, `i.e` and `8.1` all have a
// one-character or numeric tail — so one-letter source extensions are admitted by ALLOWLIST
// rather than by relaxing it. The scan reads `.c` and `.h`, so those filenames are as forbidden
// by the contract as `.ts` is.
describe('bareFilenameCandidates one-letter extensions', () => {
  it('admits the C source extensions the scan now reads', () => {
    expect(bareFilenameCandidates('see invoice-processor.c for the loop')).toContain(
      'invoice-processor.c',
    );
    expect(bareFilenameCandidates('declared in InvoiceRow.h')).toContain('InvoiceRow.h');
  });

  it('still keeps ordinary prose out', () => {
    // These are exactly what the floor was written for; relaxing the quantifier would delete
    // blocks over them.
    for (const text of ['e.g. use a queue', 'i.e. the second pass', 'upgrade to 8.1 first']) {
      expect(bareFilenameCandidates(text)).toEqual([]);
    }
  });
});
