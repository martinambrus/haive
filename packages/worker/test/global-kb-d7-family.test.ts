import { describe, expect, it } from 'vitest';
import { extractProjectFacets } from '@haive/shared/global-kb';
import { facetsMatchProject } from '../src/step-engine/steps/_global-kb-digest.js';

const d7 = extractProjectFacets({
  data: { project: { framework: 'drupal7', frameworkMajor: '7', primaryLanguage: 'php' } },
});
const d10 = extractProjectFacets({
  data: { project: { framework: 'drupal', frameworkMajor: '10', primaryLanguage: 'php' } },
});

describe('a Drupal 7 project against global KB entry facets', () => {
  it('matches an entry scoped to drupal', () => {
    expect(facetsMatchProject({ framework: ['drupal'] }, d7)).toBe(true);
  });

  it('matches an entry scoped to drupal major 7', () => {
    expect(facetsMatchProject({ framework: ['drupal'], frameworkMajor: ['7'] }, d7)).toBe(true);
  });

  it('still matches an entry scoped to drupal7', () => {
    expect(facetsMatchProject({ framework: ['drupal7'] }, d7)).toBe(true);
  });

  it('rejects an entry scoped to drupal major 10', () => {
    expect(facetsMatchProject({ framework: ['drupal'], frameworkMajor: ['10'] }, d7)).toBe(false);
  });
});

describe('a Drupal 10 project against global KB entry facets', () => {
  it('rejects an entry scoped to drupal7', () => {
    expect(facetsMatchProject({ framework: ['drupal7'] }, d10)).toBe(false);
  });
});
