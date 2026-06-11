import { describe, expect, it } from 'vitest';
import { extractProjectFacets, majorOf } from '../src/global-kb/facets.js';

describe('majorOf', () => {
  it('extracts the leading integer as the major token', () => {
    expect(majorOf('8.3')).toBe('8');
    expect(majorOf('^7.4.1')).toBe('7');
    expect(majorOf('20')).toBe('20');
    expect(majorOf('v18.2')).toBe('18');
  });
  it('returns null when there is no integer', () => {
    expect(majorOf(null)).toBeNull();
    expect(majorOf(undefined)).toBeNull();
    expect(majorOf('')).toBeNull();
    expect(majorOf('latest')).toBeNull();
  });
});

describe('extractProjectFacets', () => {
  it('reads the detect-column shape ({ data: EnvDetectData })', () => {
    const facets = extractProjectFacets({
      data: {
        project: { framework: 'drupal', frameworkMajor: '11', primaryLanguage: 'php' },
        stack: { runtimeVersions: { php: '8.3', node: '20.1' } },
      },
    });
    expect(facets.framework).toEqual(['drupal']);
    expect(facets.frameworkMajor).toEqual(['11']);
    expect(facets.language).toEqual(['php']);
    expect(facets.phpMajor).toEqual(['8']);
    expect(facets.nodeMajor).toEqual(['20']);
  });

  it('reads the apply-output shape ({ enrichedData: EnvDetectData })', () => {
    const facets = extractProjectFacets({
      enrichedData: {
        project: { framework: 'drupal', primaryLanguage: 'php' },
        stack: { language: 'php', runtimeVersions: {} },
      },
    });
    expect(facets.framework).toEqual(['drupal']);
    expect(facets.language).toEqual(['php']);
    expect(facets.phpMajor).toEqual([]);
    expect(facets.nodeMajor).toEqual([]);
  });

  it('reads a bare EnvDetectData and falls back to stack.language', () => {
    const facets = extractProjectFacets({
      project: { framework: 'nextjs' },
      stack: { language: 'javascript', runtimeVersions: { node: '20' } },
    });
    expect(facets.framework).toEqual(['nextjs']);
    expect(facets.language).toEqual(['javascript']);
    expect(facets.nodeMajor).toEqual(['20']);
  });

  it('returns an empty facet set for null/garbage', () => {
    for (const bad of [null, undefined, 42, 'x', {}]) {
      const facets = extractProjectFacets(bad);
      expect(facets.framework).toEqual([]);
      expect(facets.language).toEqual([]);
      expect(facets.phpMajor).toEqual([]);
      expect(facets.nodeMajor).toEqual([]);
    }
  });
});
