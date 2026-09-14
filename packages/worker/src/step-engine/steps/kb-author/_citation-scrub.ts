import path from 'node:path';
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
const PATH_LIKE = /(?:^|[\s`("[<])((?:\.\/)?[\w.-]+(?:\/[\w.-]+)+\/?)/g;

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
    const rel = raw.replace(/^\.\//, '').replace(/\/+$/, '');
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
