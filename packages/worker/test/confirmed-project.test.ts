import { describe, it, expect } from 'vitest';
import { mergeConfirmedProject } from '../src/step-engine/steps/onboarding/_helpers.js';

// 02-detection-confirmation lets a person correct a misdetection. `07-generate-files`
// already honoured that (extractProjectInfo); 06_5, 06_7 and 09_7 read the raw scan, so
// one run answered the same question two ways — a corrected framework decided WHICH
// agent templates were written while the raw one decided which agents were offered,
// what the scope pickers excluded, and how the global KB was scoped.
describe('mergeConfirmedProject', () => {
  const detected = { framework: 'general', primaryLanguage: 'php' };

  it('prefers what the user confirmed over what was detected', () => {
    expect(
      mergeConfirmedProject(detected, { framework: 'drupal7', primaryLanguage: 'php' }),
    ).toEqual({ framework: 'drupal7', primaryLanguage: 'php' });
  });

  // The form submits every field, so an untouched one arrives as '' or whitespace.
  // That is not a decision to erase what the scan found.
  it('treats an empty or blank confirmed value as "not answered"', () => {
    expect(
      mergeConfirmedProject(
        { framework: 'drupal7', primaryLanguage: 'php' },
        {
          framework: '  ',
          primaryLanguage: '',
        },
      ),
    ).toEqual({ framework: 'drupal7', primaryLanguage: 'php' });
  });

  it('falls back to detection when 02 has not run', () => {
    expect(
      mergeConfirmedProject({ framework: 'drupal7', primaryLanguage: 'php' }, undefined),
    ).toEqual({ framework: 'drupal7', primaryLanguage: 'php' });
  });

  it('ignores a non-string confirmed value', () => {
    expect(mergeConfirmedProject(detected, { framework: 42, primaryLanguage: null })).toEqual({
      framework: 'general',
      primaryLanguage: 'php',
    });
  });

  it('is null on both when neither step has anything to say', () => {
    expect(mergeConfirmedProject(undefined, undefined)).toEqual({
      framework: null,
      primaryLanguage: null,
    });
  });
});
