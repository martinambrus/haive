import path from 'node:path';
import { SANDBOX_WORKDIR } from '../../../sandbox/sandbox-runner.js';
import { pathExists } from '../onboarding/_helpers.js';

/** What was taken out of an article, and why. Surfaced on the step output so the removal is
 *  visible at review rather than silently shrinking the draft. */
export interface ScrubbedBlock {
  /** The offending token — a cited path, a `file:line` reference, or a repo symbol. */
  reason: string;
  /** Start of the removed block, for the reviewer to recognise it. */
  excerpt: string;
}

export interface ScrubResult {
  body: string;
  removed: ScrubbedBlock[];
}

/** A `file.ext:12` or `file.ext:12-18` reference — a claim about a specific file at a specific
 *  moment, so never part of an abstracted example, and the first thing to rot. The SVG entry
 *  that prompted all this cited `internal_menu_block.tpl.php:83-88`.
 *
 *  The shape ALONE cannot decide, which is why `lineRefHits` qualifies every match rather than
 *  treating one as a violation outright: `activit.module:534` and `api.internal:8080` are the
 *  same token shape, and stripping a block for naming a host and port would silently delete
 *  legitimate prose from an article about caches or services. */
const LINE_REF = /[\w][\w./-]*\.[A-Za-z][\w]*:\d+(?:-\d+)?/g;

export interface LineRefHit {
  token: string;
  /** The part before the line number, as a repo-relative path candidate. */
  filePath: string;
  /** Contains a `/`, so it is a path rather than a bare `host:port`. */
  hasPathSeparator: boolean;
}

/** Line references in one block, each qualified so the caller can decide.
 *
 *  A match inside a URL authority (`redis://cache.local:6379`) is dropped: it is preceded by the
 *  TWO slashes of a scheme. One slash is not enough to skip on — `/var/lib/foo.php:12` is an
 *  absolute path and a real citation. The pattern must also start on a word character, or it
 *  would swallow those slashes itself and never see what precedes them. */
export function lineRefHits(block: string): LineRefHit[] {
  const out: LineRefHit[] = [];
  for (const m of block.matchAll(LINE_REF)) {
    const token = m[0];
    const at = m.index ?? 0;
    if (at >= 2 && block[at - 1] === '/' && block[at - 2] === '/') continue;
    const colon = token.lastIndexOf(':');
    const filePath = token.slice(0, colon);
    out.push({ token, filePath, hasPathSeparator: filePath.includes('/') });
  }
  return out;
}

/** Anything shaped like a repo-relative path, WITH or without a file extension.
 *
 *  Deliberately broad, because on its own it decides nothing: a hit is only a violation once it
 *  RESOLVES inside the anchor repo (see scrubCitations). Breadth here costs a `stat`; narrowness
 *  would miss the directory citations that are the common case — the SVG entry led with
 *  `sites/all/themes/activit/img/`, which carries no extension and which the existing
 *  `extractCitedPaths` therefore skips. */
const PATH_LIKE = /(?:^|[\s`("[<])(\/?(?:\.\/)?[\w.-]+(?:\/[\w.-]+)+\/?)/g;

/** A BARE filename — `acme.config.ts` — with no slash and no line number, so neither pattern
 *  above sees it. The authoring contract forbids filenames as well as paths, and an anchored
 *  model that has just read the tree reaches for them naturally.
 *
 *  The last segment must be alphabetic and at least two characters, which keeps prose out:
 *  `e.g`, `i.e` and a version like `8.1` all have a one-character or numeric tail. */
const BARE_FILENAME = /(?:^|[\s`("[<])([\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,8})(?=[\s`)"\].,;:!?<]|$)/g;

/** Filenames that name an ECOSYSTEM TOOL rather than this repository.
 *
 *  Resolution alone cannot separate `acme.config.ts` from `composer.json`: both sit at the root
 *  of the anchor repo, and they share a shape, so no pattern tells them apart. But only one of
 *  them is "one repo's geography" — the other is vocabulary every project of that stack shares,
 *  and a house rule that says "declare it in composer.json" is exactly the generic advice this
 *  article is supposed to contain.
 *
 *  Err toward KEEPING content when extending this: a name that is missing costs a deleted block
 *  of somebody's article, silently, while a name wrongly present costs only a filename surviving
 *  into a draft a human reviews. Additions are cheap; removals are not. */
const ECOSYSTEM_FILENAMES = new Set(
  [
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lockb',
    'composer.json',
    'composer.lock',
    'tsconfig.json',
    'jsconfig.json',
    'vite.config.ts',
    'vite.config.js',
    'webpack.config.js',
    'rollup.config.js',
    'jest.config.js',
    'vitest.config.ts',
    'playwright.config.ts',
    'phpunit.xml',
    'tailwind.config.js',
    'postcss.config.js',
    'babel.config.js',
    'eslint.config.js',
    'docker-compose.yml',
    'docker-compose.yaml',
    'dockerfile',
    'readme.md',
    'license.md',
    'changelog.md',
    'contributing.md',
    'makefile',
    'settings.php',
    'services.yml',
    'gemfile',
    'rakefile',
    'go.mod',
    'go.sum',
    'requirements.txt',
    'pyproject.toml',
    'setup.py',
    'cargo.toml',
  ].map((n) => n.toLowerCase()),
);

/** Whether a bare filename's STEM is specific to a codebase, rather than a name any project
 *  might use.
 *
 *  Deliberately NOT `isDistinctiveSymbol`, which this used at first. That rule is about SYMBOLS,
 *  and a symbol cannot contain a hyphen — while kebab-case is how a large share of real source
 *  files are named (every file in this directory included). Reusing it therefore missed
 *  `invoice-processor.ts`, which is the most common shape of exactly what the rule exists to
 *  catch, while still matching `invoiceProcessor.ts` nobody writes.
 *
 *  All three multi-word conventions, then: a camel hump, an underscore, or a hyphen. A stem with
 *  none of them — `config`, `index`, `utils` — belongs to no repository in particular and is left
 *  alone unless it resolves at the repo ROOT, where the manifests live. */
export function isDistinctiveFileStem(stem: string): boolean {
  return /[a-z][A-Z]|.[A-Z][a-z]|[_-]/.test(stem);
}

/** Bare filenames in one block that might name a file in the anchor repo. */
export function bareFilenameCandidates(block: string): string[] {
  const out = new Set<string>();
  for (const m of block.matchAll(BARE_FILENAME)) {
    const name = m[1];
    if (!name) continue;
    if (ECOSYSTEM_FILENAMES.has(name.toLowerCase())) continue;
    out.add(name);
  }
  return [...out];
}

/** Split markdown into blocks, keeping a fenced code block whole.
 *
 *  Blocks and not lines, because removing the line a citation sits on leaves a dangling
 *  sentence or half a code sample. A fence is one block for the same reason. */
export function splitIntoBlocks(body: string): string[] {
  const blocks: string[] = [];
  const lines = body.split('\n');
  let current: string[] = [];
  let fence: string | null = null;
  const flush = (): void => {
    if (current.length > 0) blocks.push(current.join('\n'));
    current = [];
  };
  for (const line of lines) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fence) {
      current.push(line);
      if (fenceMatch && line.trim().startsWith(fence)) {
        fence = null;
        flush();
      }
      continue;
    }
    if (fenceMatch) {
      flush();
      fence = fenceMatch[1]!;
      current.push(line);
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

/** Path-like tokens in one block, normalised for a repo lookup. */
export function citationCandidates(block: string): string[] {
  const out = new Set<string>();
  for (const m of block.matchAll(PATH_LIKE)) {
    const raw = m[1];
    if (!raw) continue;
    let rel = raw.replace(/^\.\//, '').replace(/\/+$/, '');
    if (rel.startsWith('/')) {
      // An ABSOLUTE path is a citation only when it names the sandbox's own working directory,
      // which IS the anchor repo — an agent that cites what it read often writes the container
      // path it saw. Anything else absolute (`/etc/passwd`, `/var/log/...`) belongs to no
      // repository, and `resolveInsideRepo` would reject it anyway.
      if (!rel.startsWith(`${SANDBOX_WORKDIR}/`)) continue;
      rel = rel.slice(SANDBOX_WORKDIR.length + 1);
    }
    // A bare `a/b` with no dot and one slash is as likely to be prose ("and/or") or a fraction
    // as a path; require either an extension or real depth before spending a stat on it.
    if (!rel.includes('.') && rel.split('/').length < 3) continue;
    // No URL guard is needed: the pattern wants a delimiter before the token and `:` is not a
    // path separator, so `https://host/x` never matches in the first place (asserted).
    out.add(rel);
  }
  return [...out];
}

/** The absolute path a candidate names inside the anchor repo, or null if it escapes.
 *
 *  A citation is by definition something IN the repository, so a token that resolves outside it
 *  is not one — and probing it anyway turns any article that shows a traversal example into a
 *  false positive: `../../../../../../etc/passwd` joins to `/etc/passwd`, which exists on the
 *  worker, so a block warning about path traversal was deleted for naming the attack it warns
 *  about. Compared against the root plus a separator, so a sibling `<root>-backup` cannot pass
 *  as a prefix match. */
export function resolveInsideRepo(repoPath: string, candidate: string): string | null {
  const root = path.resolve(repoPath);
  const target = path.resolve(root, candidate);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

/**
 * Remove blocks that cite a real codebase.
 *
 * Two detectors, because they answer different questions and only one of them can run without a
 * repository:
 *
 * - A `file:line` reference is a violation ANYWHERE. Nothing abstracted needs a line number.
 * - A path is a violation only when it RESOLVES inside the anchor repo. Verifying beats matching
 *   a shape: an invented example path (`src/components/Button.tsx`) does not exist there and is
 *   left alone, while `sites/all/themes/activit/img/` does and is removed. A shape rule strict
 *   enough to catch the second would shred the first, and abstracted examples full of paths are
 *   exactly what the prompt now asks for.
 *
 * Repo-less runs therefore scrub line references only — which is right, not a gap: with no
 * repository there is nothing private to leak, and a hallucinated path is a quality problem the
 * draft review catches.
 *
 * Blocks are dropped rather than rewritten. Editing someone's sentence to remove a path leaves a
 * claim with its evidence quietly deleted; removing the block and SAYING so at review does not.
 *
 * CALIBRATION. Every rule here can only err in two directions, and they do not cost the same: a
 * miss lets a citation reach a draft a human reviews, while a false hit deletes a block of
 * somebody's article, silently. Widen a rule only with evidence that it does not start removing
 * real content — and measure that against the WHOLE article corpus, not one sample. One article
 * showed zero removals while the rule set was deleting 7 of 167 blocks across the other ten,
 * because a single sample cannot exercise a rule that fires on ordinary vocabulary. MEASURED
 * against all 11 stored articles (167 blocks, 30,469 chars) anchored to FOUR live repositories
 * whose scans yield 10k-21k symbols each: ZERO blocks removed in every one. Use several repos —
 * a rule set that scored zero on the first still deleted blocks on two others, because what
 * leaks in is whatever a given checkout happens to vendor. That is the check to re-run before adding a
 * seventh rule — one that cannot be shown harmless on known-good prose is not ready.
 */
export async function scrubCitations(
  body: string,
  opts: {
    /** The anchor repo, or null for a repo-less run. */
    repoPath: string | null;
    /** Symbols DEFINED in the anchor repo, from `collectRepoSymbols`. Empty for repo-less. */
    repoSymbols?: ReadonlySet<string>;
    /** First repo-defined symbol the text leans on, or null. Injected so this module does not
     *  depend on the knowledge step; `bodyUsesRepoSymbol` is the production implementation. */
    findSymbol?: (text: string, symbols: ReadonlySet<string>) => string | null;
    /** Lowercased basenames of the anchor repo's own files, from `collectRepoBasenames`. Lets a
     *  bare filename be recognised wherever it lives, not only at the repo root. Absent restores
     *  the root-only behaviour exactly. */
    repoBasenames?: ReadonlySet<string>;
  },
): Promise<ScrubResult> {
  const blocks = splitIntoBlocks(body);
  const kept: string[] = [];
  const removed: ScrubbedBlock[] = [];

  for (const block of blocks) {
    let reason: string | null = null;

    // A SLASHED path is a file reference whatever the mode. A bare `word.word:123` is the
    // ambiguous case — indistinguishable from `host:port` — so it only counts when the file
    // actually resolves in the anchor repo.
    //
    // A range does NOT settle it either, though it looks like it should: `db.example.com:8000-9000`
    // is a port range in ordinary networking prose and shares its shape with
    // `internal_menu_block.tpl.php:83-88`. Treating a range as proof deleted the block a
    // networking rule was written in. Anchored, the real citation still resolves and is caught;
    // repo-less it is left alone, on the reasoning this module already applies to paths —
    // nothing private to leak, and a hallucinated reference is a quality problem the draft
    // review catches, where deleting real prose is silent and worse.
    for (const hit of lineRefHits(block)) {
      if (hit.hasPathSeparator) {
        reason = hit.token;
        break;
      }
      if (opts.repoPath && (await pathExists(path.join(opts.repoPath, hit.filePath)))) {
        reason = hit.token;
        break;
      }
    }

    if (!reason && opts.repoPath) {
      for (const candidate of citationCandidates(block)) {
        const target = resolveInsideRepo(opts.repoPath, candidate);
        if (target && (await pathExists(target))) {
          reason = candidate;
          break;
        }
      }
      // Bare filenames resolve at the repo ROOT for ANY name — that is where the config and
      // manifests a model reaches for live — and anywhere in the tree for a DISTINCTIVE one.
      //
      // The split is the whole point. Matching every basename against the whole tree would delete
      // a block for saying `config.php` or `utils.ts`, names that belong to no repository in
      // particular and appear in invented examples constantly; the scrub's two errors are not
      // equal, and a false hit silently removes somebody's prose. A stem carrying a hump or an
      // underscore or a hyphen is specific to a codebase — see `isDistinctiveFileStem`, which is
      // a FILENAME rule rather than the symbol one. `InvoiceProcessor.ts` and
      // `invoice-processor.ts` under `src/` are caught; `index.php` under `web/` is not.
      if (!reason) {
        for (const name of bareFilenameCandidates(block)) {
          const target = resolveInsideRepo(opts.repoPath, name);
          if (target && (await pathExists(target))) {
            reason = name;
            break;
          }
          if (
            opts.repoBasenames?.has(name.toLowerCase()) &&
            isDistinctiveFileStem(name.replace(/\.[^.]+$/, ''))
          ) {
            reason = name;
            break;
          }
        }
      }
    }

    if (!reason && opts.repoSymbols && opts.repoSymbols.size > 0 && opts.findSymbol) {
      const symbol = opts.findSymbol(block, opts.repoSymbols);
      if (symbol) reason = symbol;
    }

    if (reason) {
      removed.push({ reason, excerpt: block.slice(0, 200) });
      continue;
    }
    kept.push(block);
  }

  return { body: kept.join('\n\n').trim(), removed };
}
