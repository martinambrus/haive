import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  ImplementationFileSet,
  ChangedLineNotes,
  FileCoverage,
  Insight,
} from '@haive/shared/step';
import type * as WorkerInsights from '../src/step-engine/steps/workflow/08e-insights-triage.js';
import * as workerPrompts from '../src/step-engine/steps/_untrusted-repo.js';
import * as workerReview from '../src/step-engine/steps/workflow/_impl-changes.js';
import { findingFingerprint } from '../src/step-engine/steps/workflow/_review-findings.js';
import { INSIGHTS_INSTRUCTION } from '../src/step-engine/steps/workflow/08e-insights-triage.js';
import { SCOPE_BOUNDARY, SCOPE_FENCE_INSIGHTS } from '../src/step-engine/steps/_scope-fence.js';
import * as prompts from '@haive/shared/step/prompts';
import * as review from '@haive/shared/step/review';
import { captureLeaves } from './fixtures/step-sdk/leaf-cases.js';

const oldPrompts = { ...workerPrompts, INSIGHTS_INSTRUCTION, SCOPE_BOUNDARY };
const oldReview = { ...workerReview, findingFingerprint };
const fixture = new URL('./fixtures/step-sdk/leaf-baseline.json', import.meta.url);

describe('step SDK leaf parity', () => {
  it('exposes the same four DTO types through the contract and worker entries', () => {
    expectTypeOf<ImplementationFileSet>().toEqualTypeOf<workerReview.ImplementationFileSet>();
    expectTypeOf<ChangedLineNotes>().toEqualTypeOf<workerReview.ChangedLineNotes>();
    expectTypeOf<FileCoverage>().toEqualTypeOf<workerReview.FileCoverage>();
    expectTypeOf<Insight>().toEqualTypeOf<WorkerInsights.Insight>();
  });

  it('shares canonical values and functions with the worker compatibility paths', () => {
    expect(Object.keys(prompts).sort()).toEqual([
      'INSIGHTS_INSTRUCTION',
      'REPO_IS_DATA_ACTING_LINES',
      'REPO_IS_DATA_ANSWER_LINES',
      'REPO_IS_DATA_AUTHORING_LINES',
      'REPO_IS_DATA_LINES',
      'SCOPE_BOUNDARY',
      'balanceFences',
      'fencedAgentBlock',
    ]);
    expect(Object.keys(review).sort()).toEqual([
      'assertReviewableChange',
      'changedFilesBlock',
      'fileCoverage',
      'findingFingerprint',
      'parseChangedLineRanges',
    ]);
    for (const key of Object.keys(prompts) as (keyof typeof prompts)[]) {
      expect(prompts[key]).toBe(oldPrompts[key]);
    }
    for (const key of Object.keys(review) as (keyof typeof review)[]) {
      expect(review[key]).toBe(oldReview[key]);
    }
  });
  it('preserves the captured pre-extraction values, including empty, cap and error cases', () => {
    const actual = captureLeaves(prompts, review);
    expect(SCOPE_FENCE_INSIGHTS.slice(0, -5)).toEqual(prompts.SCOPE_BOUNDARY);
    expect(captureLeaves(oldPrompts, oldReview)).toEqual(actual);
    expect(actual).toEqual(JSON.parse(readFileSync(fixture, 'utf8')));
  });
});
