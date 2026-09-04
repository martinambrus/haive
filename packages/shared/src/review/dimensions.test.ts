import { describe, expect, it } from 'vitest';
import {
  ALL_REVIEW_DIMENSION_IDS,
  REVIEW_DIMENSIONS,
  dimensionScopeOverride,
  inlineDimensionList,
  normalizeReviewDimensionIds,
  numberedDimensionBlock,
  resolveReviewDimensions,
} from './dimensions.js';

// The exact Step 7 table 07b-phase-4-validate emitted before the dimension set
// became selectable, pasted verbatim. Every install that has not touched the
// setting still renders this, so a diff here is a prompt regression for
// everyone — not a formatting nit.
const ORIGINAL_STEP_7_TABLE = [
  '1. Security - spec-named inputs validated/escaped at entry; required permission/authz gates',
  '   present; no hardcoded secrets; parameterized queries; output escaped (e.g. check_plain()/',
  "   filter_xss() or your framework's escaping)",
  '2. Maintainability - no hidden complexity that should be config; no new helper duplicating an',
  '   existing function; new code in the right file/module',
  '3. Testability - every spec-listed error branch is triggerable; functions not monolithic; no',
  '   hidden time/random/network dependencies (or isolated behind an injectable seam)',
  '4. Usability - user-facing strings exist and are correct; error messages user-friendly;',
  '   confirmation prompts for destructive actions the spec names (visual checks happen later in',
  '   browser testing)',
  '5. Stability - dependency failures (DB, HTTP, file IO) caught and handled per spec; no empty',
  '   catch blocks; any write/charge/external-effect that can run twice (retry, redelivery,',
  '   double-submit) is guarded against double-writes (idempotency key, dedupe, upsert, or unique',
  '   constraint), whether or not the spec named it idempotent',
  '6. Performance - no new N+1 queries; new WHERE/ORDER BY columns indexed per spec; no blocking',
  '   external HTTP on the request hot path',
  '7. Observability - failure paths log with context; no silent catches (log OR rethrow OR typed',
  '   error); logged context sufficient to debug from the log alone',
  '8. Operational Readiness - migrations (e.g. hook_update_N or framework equivalent) idempotent',
  '   and present where required; post-deploy cache clears documented; cron impact reasonable',
  '9. Data Integrity - atomic operations wrapped in transactions; cascading deletes honored;',
  '   server-side validation at every boundary; read-modify-write races identified',
  '10. Developer Experience - matches existing structure and naming; comments only where',
  '    non-obvious; no "TODO: figure out later" left in code',
  '11. Accessibility - ARIA labels per spec; form fields labeled; keyboard navigation works; color',
  '    not the sole carrier of information',
  '12. Internationalization - cross-reference Step 6 findings',
  '13. Backward Compatibility - renamed functions/hooks/services have all callers updated',
  '    (cross-reference Step 4); schema drops/renames have a migration path; public API signatures',
  '    unchanged or additive',
  '14. Privacy / Compliance - spec-named PII stored/logged per spec; audit trail for sensitive',
  '    actions; retention rules respected',
];

describe('numberedDimensionBlock', () => {
  it('reproduces the original 14-dimension table byte for byte', () => {
    expect(numberedDimensionBlock(REVIEW_DIMENSIONS)).toEqual(ORIGINAL_STEP_7_TABLE);
  });

  it('renumbers and re-indents when dimensions are dropped', () => {
    const { enabled } = resolveReviewDimensions(['accessibility', 'security']);
    const lines = numberedDimensionBlock(enabled);
    // Canonical order wins over the order the ids were given in.
    expect(lines[0]).toMatch(/^1\. Security - /);
    expect(lines.find((l) => l.startsWith('2. Accessibility'))).toBeDefined();
    // Accessibility was #11 (4-space continuation); at #2 it indents by 3.
    expect(lines).toContain('   not the sole carrier of information');
    expect(lines).not.toContain('    not the sole carrier of information');
  });

  it('renders nothing for an empty set', () => {
    expect(numberedDimensionBlock([])).toEqual([]);
  });
});

describe('resolveReviewDimensions', () => {
  it('treats null as every dimension, excluding none', () => {
    const { enabled, excluded } = resolveReviewDimensions(null);
    expect(enabled).toHaveLength(REVIEW_DIMENSIONS.length);
    expect(excluded).toEqual([]);
  });

  it('splits the catalog and keeps canonical order', () => {
    const { enabled, excluded } = resolveReviewDimensions(['testability', 'security']);
    expect(enabled.map((d) => d.id)).toEqual(['security', 'testability']);
    expect(excluded).toHaveLength(REVIEW_DIMENSIONS.length - 2);
    expect(excluded.map((d) => d.id)).not.toContain('security');
  });

  it('ignores ids the catalog does not know', () => {
    const { enabled } = resolveReviewDimensions(['security', 'retired-dimension']);
    expect(enabled.map((d) => d.id)).toEqual(['security']);
  });

  it('passes an empty selection through rather than re-expanding it', () => {
    const { enabled, excluded } = resolveReviewDimensions([]);
    expect(enabled).toEqual([]);
    expect(excluded).toHaveLength(REVIEW_DIMENSIONS.length);
  });
});

describe('normalizeReviewDimensionIds', () => {
  it('drops unknown and non-string ids, de-dupes, and sorts canonically', () => {
    expect(
      normalizeReviewDimensionIds(['usability', 'security', 'security', 'nope', 7, null]),
    ).toEqual(['security', 'usability']);
  });

  it('accepts the full set unchanged', () => {
    expect(normalizeReviewDimensionIds([...ALL_REVIEW_DIMENSION_IDS])).toEqual([
      ...ALL_REVIEW_DIMENSION_IDS,
    ]);
  });
});

describe('dimensionScopeOverride', () => {
  it('emits nothing when every dimension is enabled', () => {
    expect(dimensionScopeOverride(resolveReviewDimensions(null))).toBe('');
    expect(dimensionScopeOverride(resolveReviewDimensions([...ALL_REVIEW_DIMENSION_IDS]))).toBe('');
  });

  it('names both the kept and the excluded dimensions', () => {
    const selection = resolveReviewDimensions(
      ALL_REVIEW_DIMENSION_IDS.filter((id) => id !== 'accessibility'),
    );
    const block = dimensionScopeOverride(selection);
    expect(block).toContain('Score ONLY these dimensions: Security,');
    expect(block).toContain('Do NOT raise findings under: Accessibility.');
    expect(block).toContain('overrides any repository agent definition');
  });
});

describe('inlineDimensionList', () => {
  it('uses one spelling per dimension', () => {
    const all = inlineDimensionList(REVIEW_DIMENSIONS);
    expect(all).toContain('Internationalization');
    expect(all).toContain('Privacy / Compliance');
    expect(all).not.toContain('i18n');
  });

  it('lists only the dimensions it is given', () => {
    const { enabled, excluded } = resolveReviewDimensions(['security', 'performance']);
    expect(inlineDimensionList(enabled)).toBe('Security, Performance');
    expect(inlineDimensionList(excluded)).not.toContain('Security');
  });
});
