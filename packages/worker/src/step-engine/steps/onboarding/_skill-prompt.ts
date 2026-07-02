// Single source of truth for the SKILL JSON contract handed to CLI agents. Both the
// skill GENERATOR (09_5-skill-generation buildSkillPrompt) and the skill REPAIRER
// (09_5b-skill-repair) emit the SAME `{ "skills": [ ... ] }` shape, so the invariant
// blocks — the required sub-skill body structure, the JSON output format, and the hard
// rules — live here and are spliced into both prompts. Keeping them in one place means a
// schema change (a new field, a renamed section) updates generation and repair together,
// so a repaired skill can never drift from what the generator/parser expect. The parsing
// side is already single-sourced via parseSkillEntries + skillEntrySchema (@haive/shared).

/** The invariant contract blocks (sub-skill body structure + JSON output format + hard
 *  rules) as prompt lines. `maxSub` caps the sub-skill count and `bodyLen` sets the
 *  per-sub-skill body length band; both callers pass the same values they use elsewhere
 *  in their prompt so the numbers stay consistent. Returned as an array so callers splice
 *  it into their own line list with `...buildSkillContractBlocks(...)`. */
export function buildSkillContractBlocks(maxSub: number, bodyLen: string): string[] {
  return [
    '## Required sub-skill body structure',
    '',
    'Each sub-skill `body` MUST cover these sections in this order. Omit a section ONLY if it is genuinely not applicable, never to save space:',
    '',
    '1. `## Purpose` — one paragraph naming the exact capability and its role in the codebase.',
    '2. `## When To Use It` — concrete triggers (file changed, error encountered, task type).',
    '3. `## When NOT To Use It` — explicit out-of-scope list so future agents do not over-apply.',
    '4. `## Process` or `## What X Does` — step-by-step or sequence diagram. Include task chains, command order, control flow.',
    '5. `## Resulting State` or `## Directory Layout` (when applicable) — concrete tree / output / artifact list with absolute or repo-relative paths.',
    '6. `## Code Pattern` — annotated code block(s). For each pattern, show the canonical form with comments explaining the load-bearing parts.',
    '7. `## Pattern: <name>` blocks — at least 2 reproducible recipes (e.g. "force re-download", "manual cache pre-population", "skip validation"), each with shell commands or code, expected output, and when to use that variant.',
    '8. `## Runtime Requirements` (when applicable) — environment variables, library paths, OS-specific notes, exact error symptoms when the requirement is missing.',
    '9. `## Pitfalls & Edge Cases` — REQUIRED. Split into three subsections:',
    '   - `### Common Mistakes` — wrong approaches an agent might naively try, with the specific symptom each produces (`UnsatisfiedLinkError`, `cannot find symbol class X`, etc.).',
    '   - `### Edge Cases` — known weird states (network flake, partial downloads, version skew) and how to recognise them.',
    '   - `### Known Limitations` — accepted gaps (no checksum verification, no incremental rebuild, single point of failure) so agents do not propose fixing out-of-scope work.',
    '10. `## Related Sub-Skills` — list cross-links with `[name](./other.md) — one-line reason to follow`.',
    '',
    'Every concrete claim MUST cite a file path with line range — `build.gradle:13-41`, `src/com/foo/Bar.java:120` — never just `build.gradle`. Generic prose without a citation is a defect.',
    '',
    '## JSON output format',
    '',
    'Emit ONE JSON object inside a single ```json fenced code block. The `skills` array',
    'holds EXACTLY ONE skill (or zero, only when signalling done in discovery mode):',
    '',
    '```json',
    '{',
    '  "skills": [',
    '    {',
    '      "id": "<kebab-case capability id — NOT a KB filename, NOT ending in -skill>",',
    '      "title": "<Title Case skill title>",',
    '      "description": "<activation description for SKILL.md frontmatter — include trigger keywords>",',
    '      "quickStart": "<short code block or command demonstrating typical usage — optional>",',
    '      "overview": "<1-2 paragraphs: what this domain covers, when an agent invokes it, why it exists in this codebase>",',
    '      "keyConcepts": [ { "term": "<term>", "definition": "<one-sentence definition>" } ],',
    '      "quickReference": "<optional markdown table summarising constants and sources>",',
    '      "decisionTree": "<optional markdown block routing the reader to the right sub-skill>",',
    '      "relatedSkills": [ { "path": "../<other-skill>/SKILL.md", "summary": "<one line>" } ],',
    '      "codeLocations": [ { "label": "<human label>", "path": "<concrete repo-relative path>" } ],',
    '      "subSkills": [',
    '        {',
    '          "slug": "<kebab-case filename, no extension>",',
    '          "name": "<full frontmatter name — convention: <skill-id>-<slug>>",',
    '          "title": "<H1 title of the sub-skill file>",',
    '          "description": "<activation description in sub-skill frontmatter>",',
    '          "category": "<optional grouping shown under ## Sub-Skills in parent>",',
    '          "summary": "<short line shown beside the sub-skill link in parent SKILL.md>",',
    `          "body": "<full markdown body following the Required sub-skill body structure above — ${bodyLen} lines, every claim cited file:line>",`,
    '          "identification": [ { "label": "Function", "value": "lib/foo.mjs::bar" } ]',
    '        }',
    '      ]',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    '## Hard rules',
    '',
    '- Emit EXACTLY ONE skill (the `skills` array has length 1), or an empty array only to signal done in discovery mode.',
    '- Ground every claim in concrete repo paths with line ranges (e.g. `lib/wrapper.mjs:42-89`, NOT "the wrapper module" and NOT `lib/wrapper.mjs` alone).',
    `- The skill MUST have at least 3 sub-skills (and at most ${maxSub}). A skill with fewer is rejected and re-rolled.`,
    '- Every sub-skill MUST include a non-empty `summary` (the one-line blurb shown beside its link in the parent SKILL.md). A sub-skill with an empty or missing `summary` is discarded, which can collapse the whole skill and force a re-roll.',
    `- Each sub-skill body SHOULD be ${bodyLen} lines following the Required sub-skill body structure above. Shorter bodies are acceptable only when a section truly does not apply — never to save effort.`,
    '- Pitfalls & Edge Cases is REQUIRED in every sub-skill, with the three subsections (Common Mistakes / Edge Cases / Known Limitations) populated. State exact error symptoms.',
    '- At least two `## Pattern: <name>` recipes per sub-skill where applicable (build steps, runtime invocations, debug procedures), each with reproducible commands.',
    '- Skill ids: kebab-case, lowercase, no `-skill` suffix, no underscores, max 64 chars.',
    '- Do NOT emit prose outside the fenced JSON block.',
    '- Do NOT write, create, edit, or install files on disk. JSON output ONLY — the',
    '  orchestrator handles all file writes. Calling write_file / edit_file / shell',
    '  `cat > ...` / `mkdir` / `cp` is a hard failure even if the JSON is also valid.',
    '- Do NOT propose generic skills like "general-knowledge", "project-overview", "documentation".',
  ];
}
