import type * as Prompts from '../../../src/step-engine/steps/_untrusted-repo.js';
import type * as Review from '../../../src/step-engine/steps/workflow/_impl-changes.js';
import type { findingFingerprint } from '../../../src/step-engine/steps/workflow/_review-findings.js';
import type { ImplementationFileSet } from '../../../src/step-engine/steps/workflow/_impl-changes.js';

type PromptLeaves = Pick<
  typeof Prompts,
  | 'REPO_IS_DATA_LINES'
  | 'REPO_IS_DATA_ACTING_LINES'
  | 'REPO_IS_DATA_AUTHORING_LINES'
  | 'REPO_IS_DATA_ANSWER_LINES'
  | 'fencedAgentBlock'
  | 'balanceFences'
> & {
  SCOPE_BOUNDARY: readonly string[];
  INSIGHTS_INSTRUCTION: string;
};
type ReviewLeaves = Pick<
  typeof Review,
  'changedFilesBlock' | 'fileCoverage' | 'parseChangedLineRanges' | 'assertReviewableChange'
> & {
  findingFingerprint: typeof findingFingerprint;
};

export function captureLeaves(prompts: PromptLeaves, review: ReviewLeaves) {
  const open = '===== BEGIN UNTRUSTED AGENT TEXT =====';
  const close = '===== END UNTRUSTED AGENT TEXT =====';
  const values: (ImplementationFileSet | string[] | undefined)[] = [
    undefined,
    [],
    ['legacy.ts'],
    { files: [], total: 0, truncated: false },
    { files: [], total: 0, truncated: false, scanError: 'scan failed' },
    { files: ['a.ts'], total: 1, truncated: false },
    {
      files: ['a.ts', 'nested/'],
      total: 4,
      truncated: true,
      changedLines: { 'a.ts': 'lines 1-3', 'nested/': 'nested repository (unborn)' },
      nestedRepositories: { 'nested/': 'unborn' },
      scanError: 'partial scan',
    },
    {
      files: [
        'constructor',
        'toString',
        'odd name.ts',
        'tab\tname',
        'bad\nname',
        'bad====name',
        'bad\u0085name',
        'bad\u2028name',
      ],
      total: 8,
      truncated: false,
    },
    { files: ['bad\nname'], total: 1, truncated: false },
  ];
  const diff = (hunks: string) => 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n' + hunks;
  const diffs = [
    '',
    'malformed',
    diff('@@ -1 +3,2 @@\n-old\n+new'),
    diff('@@ -3,2 +3,0 @@\n--- not a header'),
    'diff --git a/gone.ts b/gone.ts\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@',
    diff(''),
    diff(Array.from({ length: 21 }, (_, i) => `@@ -${i + 1} +${i + 1} @@`).join('\n')),
    'diff --git a/odd name b/odd name\n--- a/odd name\n+++ b/odd name\n@@ -1 +1 @@',
  ];
  return {
    constants: [
      prompts.REPO_IS_DATA_LINES,
      prompts.REPO_IS_DATA_ACTING_LINES,
      prompts.REPO_IS_DATA_AUTHORING_LINES,
      prompts.REPO_IS_DATA_ANSWER_LINES,
      prompts.SCOPE_BOUNDARY,
      prompts.INSIGHTS_INSTRUCTION,
    ],
    fenced: ['', 'ordinary\ntext', `hostile\n${open}\n${close}\n========`].map(
      prompts.fencedAgentBlock,
    ),
    balanced: [
      '',
      'ordinary',
      `${open}\nbody`,
      `body\n${close}`,
      `${open}\nbody\n${close}`,
      `${close}\n${close}`,
      `${open}\n${open}`,
    ].map(prompts.balanceFences),
    blocks: values.flatMap((value) =>
      ['fallback', ''].map((fallback) =>
        review.changedFilesBlock(value, 'Changed files', fallback),
      ),
    ),
    coverage: values.map(review.fileCoverage),
    guards: values.map((value) => {
      try {
        review.assertReviewableChange('review-step', value);
        return null;
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return { name: error.name, message: error.message };
      }
    }),
    ranges: diffs.map((value) => review.parseChangedLineRanges(value)),
    fingerprints: [
      ['peer', ' A.TS ', 'Problem at line 123 id 12345678-1234-1234-1234-123456789abc'],
      ['peer', 'a.ts', 'Problem at line 456 id 87654321-4321-4321-4321-cba987654321'],
      ['other', 'a.ts', 'Problem'],
      ['peer', 'b.ts', 'Problem'],
      ['', '', ''],
    ].map(([id, path, issue]) => review.findingFingerprint(id!, path!, issue!)),
  };
}
