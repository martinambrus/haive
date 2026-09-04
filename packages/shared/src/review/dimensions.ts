/** The canonical review dimensions every reviewing step scores a change against.
 *
 *  Before this module the same 14 names were hardcoded prose in five files and
 *  eleven sites, worded three different ways (`Privacy/Compliance` /
 *  `Privacy / Compliance` / `Privacy`; `Internationalization` / `i18n`). The
 *  per-dimension `criteria` below are lifted VERBATIM from the richest of those
 *  copies — 07b-phase-4-validate's Step 7 — because the other four sites carry
 *  names only.
 *
 *  Selectable per repository (the policy) with a per-task override, because not
 *  every project has every dimension: an intranet-only application may have no
 *  accessibility requirement at all, and an a11y reviewer on every task is spend
 *  with no reader.
 *
 *  NOT the same list as `QUALITY_DIMENSIONS` in 05-phase-0b5-spec-quality, which
 *  scores the SPEC (`goal_clarity` … `documentation_updates`) rather than the
 *  code. Both happen to have 14 entries; they share nothing else.
 */
export interface ReviewDimension {
  /** Stable slug. Persisted in `repositories.review_dimensions` and
   *  `tasks.review_dimensions`, so renaming one is a data migration. */
  id: string;
  /** Display and prompt name. The one spelling every site now uses. */
  label: string;
  /** The scoring criteria, as already-wrapped lines. Line 0 follows
   *  `<n>. <label> - ` and the rest are continuation lines that the renderer
   *  indents; stored pre-wrapped so a full-set render reproduces the original
   *  prompt byte for byte. */
  criteria: readonly string[];
}

export const REVIEW_DIMENSIONS: readonly ReviewDimension[] = [
  {
    id: 'security',
    label: 'Security',
    criteria: [
      'spec-named inputs validated/escaped at entry; required permission/authz gates',
      'present; no hardcoded secrets; parameterized queries; output escaped (e.g. check_plain()/',
      "filter_xss() or your framework's escaping)",
    ],
  },
  {
    id: 'maintainability',
    label: 'Maintainability',
    criteria: [
      'no hidden complexity that should be config; no new helper duplicating an',
      'existing function; new code in the right file/module',
    ],
  },
  {
    id: 'testability',
    label: 'Testability',
    criteria: [
      'every spec-listed error branch is triggerable; functions not monolithic; no',
      'hidden time/random/network dependencies (or isolated behind an injectable seam)',
    ],
  },
  {
    id: 'usability',
    label: 'Usability',
    criteria: [
      'user-facing strings exist and are correct; error messages user-friendly;',
      'confirmation prompts for destructive actions the spec names (visual checks happen later in',
      'browser testing)',
    ],
  },
  {
    id: 'stability',
    label: 'Stability',
    criteria: [
      'dependency failures (DB, HTTP, file IO) caught and handled per spec; no empty',
      'catch blocks; any write/charge/external-effect that can run twice (retry, redelivery,',
      'double-submit) is guarded against double-writes (idempotency key, dedupe, upsert, or unique',
      'constraint), whether or not the spec named it idempotent',
    ],
  },
  {
    id: 'performance',
    label: 'Performance',
    criteria: [
      'no new N+1 queries; new WHERE/ORDER BY columns indexed per spec; no blocking',
      'external HTTP on the request hot path',
    ],
  },
  {
    id: 'observability',
    label: 'Observability',
    criteria: [
      'failure paths log with context; no silent catches (log OR rethrow OR typed',
      'error); logged context sufficient to debug from the log alone',
    ],
  },
  {
    id: 'operational-readiness',
    label: 'Operational Readiness',
    criteria: [
      'migrations (e.g. hook_update_N or framework equivalent) idempotent',
      'and present where required; post-deploy cache clears documented; cron impact reasonable',
    ],
  },
  {
    id: 'data-integrity',
    label: 'Data Integrity',
    criteria: [
      'atomic operations wrapped in transactions; cascading deletes honored;',
      'server-side validation at every boundary; read-modify-write races identified',
    ],
  },
  {
    id: 'developer-experience',
    label: 'Developer Experience',
    criteria: [
      'matches existing structure and naming; comments only where',
      'non-obvious; no "TODO: figure out later" left in code',
    ],
  },
  {
    id: 'accessibility',
    label: 'Accessibility',
    criteria: [
      'ARIA labels per spec; form fields labeled; keyboard navigation works; color',
      'not the sole carrier of information',
    ],
  },
  {
    id: 'internationalization',
    label: 'Internationalization',
    criteria: ['cross-reference Step 6 findings'],
  },
  {
    id: 'backward-compatibility',
    label: 'Backward Compatibility',
    criteria: [
      'renamed functions/hooks/services have all callers updated',
      '(cross-reference Step 4); schema drops/renames have a migration path; public API signatures',
      'unchanged or additive',
    ],
  },
  {
    id: 'privacy-compliance',
    label: 'Privacy / Compliance',
    criteria: [
      'spec-named PII stored/logged per spec; audit trail for sensitive',
      'actions; retention rules respected',
    ],
  },
];

export const ALL_REVIEW_DIMENSION_IDS: readonly string[] = REVIEW_DIMENSIONS.map((d) => d.id);

export interface ReviewDimensionSelection {
  enabled: ReviewDimension[];
  excluded: ReviewDimension[];
}

/** Resolve a stored id list onto the canonical set.
 *
 *  `null`/`undefined` means "never chosen" and resolves to every dimension —
 *  the behaviour before this setting existed, which is what every pre-existing
 *  row holds. Unknown ids are ignored rather than rejected so a dimension
 *  retired from the catalog does not break stored rows, and canonical ORDER is
 *  preserved regardless of the order the ids were stored in.
 *
 *  An empty selection is passed through rather than silently re-expanded to the
 *  full set: overriding what the operator chose is worse than a degenerate
 *  prompt, and the renderers below handle zero dimensions. The form and the API
 *  require at least one, so an empty set only arrives from a direct DB edit.
 */
export function resolveReviewDimensions(
  ids: readonly string[] | null | undefined,
): ReviewDimensionSelection {
  if (ids === null || ids === undefined) {
    return { enabled: [...REVIEW_DIMENSIONS], excluded: [] };
  }
  const wanted = new Set(ids);
  const enabled: ReviewDimension[] = [];
  const excluded: ReviewDimension[] = [];
  for (const dimension of REVIEW_DIMENSIONS) {
    if (wanted.has(dimension.id)) enabled.push(dimension);
    else excluded.push(dimension);
  }
  return { enabled, excluded };
}

/** Keep only ids the catalog knows, de-duped, in canonical order. Used by the
 *  API guards on both the repository and the task write paths. */
export function normalizeReviewDimensionIds(ids: readonly unknown[]): string[] {
  const wanted = new Set(ids.filter((id): id is string => typeof id === 'string'));
  return REVIEW_DIMENSIONS.filter((d) => wanted.has(d.id)).map((d) => d.id);
}

/** 07b's Step 7 table: `<n>. <Label> - <criteria>`, continuation lines indented
 *  to clear the number. The indent widens for 10-14 exactly as the original
 *  literal did, so dropping a dimension re-numbers and re-indents the rest. */
export function numberedDimensionBlock(dimensions: readonly ReviewDimension[]): string[] {
  const lines: string[] = [];
  dimensions.forEach((dimension, i) => {
    const n = i + 1;
    const indent = ' '.repeat(String(n).length + 2);
    const [first, ...rest] = dimension.criteria;
    lines.push(`${n}. ${dimension.label} - ${first ?? ''}`);
    for (const line of rest) lines.push(`${indent}${line}`);
  });
  return lines;
}

/** The comma-joined form 08c's peer persona names inline. */
export function inlineDimensionList(dimensions: readonly ReviewDimension[]): string {
  return dimensions.map((d) => d.label).join(', ');
}

/** The last word on scope, for the three prompts that defer to a repo's own
 *  `.claude/agents/<id>.md` ("follow it; otherwise follow the protocol below").
 *
 *  Those on-disk personas still name all 14 and OUTRANK the inline persona, so
 *  filtering the inline copy alone changes nothing for a repo that has been
 *  onboarded. Rewriting the agent files is not the alternative: their bytes are
 *  hashed against a reference render, so a per-repo body would read as drifted
 *  and be reverted on the next onboarding upgrade. This block is appended AFTER
 *  the persona instead, where it is the most recent instruction.
 *
 *  Returns '' when nothing is excluded, so a full-set run emits the exact prompt
 *  it emitted before this feature existed.
 */
export function dimensionScopeOverride(selection: ReviewDimensionSelection): string {
  if (selection.excluded.length === 0) return '';
  return [
    'DIMENSION SCOPE FOR THIS RUN — this overrides any repository agent definition you were told',
    'to follow above, including its own dimension list.',
    `Score ONLY these dimensions: ${inlineDimensionList(selection.enabled) || '(none)'}.`,
    `Do NOT raise findings under: ${inlineDimensionList(selection.excluded)}. This project has`,
    'scoped those out deliberately; a finding under an excluded dimension is discarded unread, so',
    'effort spent there is wasted. Do not score them, and do not note their absence.',
    'This changes WHICH dimensions you score. It does not lower the bar for the ones that remain.',
  ].join('\n');
}
