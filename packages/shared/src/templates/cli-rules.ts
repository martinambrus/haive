/**
 * Pure helpers for the AGENTS.md `haive:cli-rules` region — the marker-delimited
 * block that holds every enabled CLI provider's merged agent rules.
 *
 * These live in @haive/shared (not the worker) so both the worker (which writes
 * the block at onboarding and re-renders it on upgrade) and the API (which
 * recomputes the block's hash to detect drift for the upgrade banner) compute
 * byte-identical output without the API importing worker code.
 */

/** Opening marker of the cli-rules region inside AGENTS.md. */
export const CLI_RULES_START = '<!-- haive:cli-rules -->';
/** Closing marker of the cli-rules region inside AGENTS.md. */
export const CLI_RULES_END = '<!-- /haive:cli-rules -->';

/** Stable identity of the cli-rules artifact, shared by the onboarding writer,
 *  the upgrade plan/apply/rollback steps, and the API drift recompute so the id,
 *  kind, and schema version never drift apart across those call sites. */
export const CLI_RULES_TEMPLATE_ID = 'cli-rules';
export const CLI_RULES_TEMPLATE_KIND = 'cli-rules-block' as const;
export const CLI_RULES_SCHEMA_VERSION = 1;
/** diskPath the region lives in. AGENTS.md is the single source every CLI reads
 *  (import-mode CLIs point at it via `@AGENTS.md`). */
export const CLI_RULES_DISK_PATH = 'AGENTS.md';

/** Merge rule blocks line-by-line, deduplicating on trimmed content so the
 *  first-seen capitalization and leading whitespace win. Runs of 3+ blank lines
 *  collapse to 2. Output is trimmed and ends with exactly one newline. Copied
 *  verbatim from the worker's original onboarding generator to keep the rendered
 *  block byte-identical across the relocation. */
export function dedupLines(blocks: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const block of blocks) {
    for (const line of block.split('\n')) {
      const key = line.trim();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(line);
    }
  }
  return (
    out
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim() + '\n'
  );
}

/** Build the full cli-rules block (markers included) from the rule strings of
 *  the enabled providers. Returns null when no provider contributes non-empty
 *  rules — callers treat null as "no region" (omit on write, obsolete on
 *  upgrade). The caller is responsible for passing the rule strings in a
 *  deterministic order (sorted by provider name) so the output is stable. */
export function buildCliRulesBlock(rulesContents: readonly string[]): string | null {
  const withRules = rulesContents.filter((c) => c.trim().length > 0);
  if (withRules.length === 0) return null;
  const combined = dedupLines(withRules.slice());
  return `${CLI_RULES_START}\n${combined}${CLI_RULES_END}\n`;
}

/** Convenience over buildCliRulesBlock for the common call shape: keep the
 *  enabled providers with non-empty rules, sort by name so the block is
 *  deterministic regardless of DB row order, then build it. Shared by the
 *  onboarding/upgrade worker steps and the upgrade-status API so all sites
 *  compute the same block — and therefore the same drift hash. */
export function buildCliRulesBlockFromProviders(
  providers: ReadonlyArray<{ name: string; rulesContent: string; enabled: boolean }>,
): string | null {
  return buildCliRulesBlock(
    providers
      .filter((p) => p.enabled && p.rulesContent.trim().length > 0)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => p.rulesContent),
  );
}

/** Return the marker-inclusive span between `startMarker` and `endMarker`
 *  (the first end marker at or after the start), or null if either marker is
 *  absent. Mirrors the slice bounds used by the onboarding writer so a written
 *  region round-trips back to the same bytes (modulo normalization). */
export function extractRegion(
  content: string,
  startMarker: string,
  endMarker: string,
): string | null {
  const start = content.indexOf(startMarker);
  if (start === -1) return null;
  const endIdx = content.indexOf(endMarker, start);
  if (endIdx === -1) return null;
  return content.slice(start, endIdx + endMarker.length);
}

/** Replace the marker-delimited region with `block` (trailing whitespace
 *  trimmed, matching the onboarding writer), or append `block` when the markers
 *  are absent. Pass an empty `block` to remove the region entirely (markers and
 *  all). Pure string transform — callers do the file read/write. Mirrors the
 *  worker's `appendOrCreate` overwrite semantics so on-disk bytes stay stable. */
export function upsertRegion(
  content: string,
  block: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = content.indexOf(startMarker);
  if (start !== -1) {
    const endIdx = content.indexOf(endMarker, start);
    if (endIdx !== -1) {
      const end = endIdx + endMarker.length;
      return content.slice(0, start) + block.trimEnd() + content.slice(end);
    }
  }
  const sep = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  return content + sep + block;
}
