import { describe, expect, it } from 'vitest';
import { extractProjectFacets, majorOf, resolveStackVersions } from '../src/global-kb/facets.js';

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

describe('resolveStackVersions', () => {
  it('derives php/node/database/dbMajor from raw detection (engine lowercased)', () => {
    expect(
      resolveStackVersions({
        stack: {
          runtimeVersions: { php: '8.3', node: '20.1' },
          database: { type: 'MariaDB', version: '10.11' },
        },
      }),
    ).toEqual({ phpMajor: '8', nodeMajor: '20', database: 'mariadb', dbMajor: '10' });
  });

  it('lets confirmed overrides win over raw detection', () => {
    expect(
      resolveStackVersions(
        { stack: { runtimeVersions: {}, database: { type: 'mysql', version: null } } },
        { phpVersion: '5.6', databaseType: 'mariadb', databaseVersion: '10.11' },
      ),
    ).toEqual({ phpMajor: '5', nodeMajor: null, database: 'mariadb', dbMajor: '10' });
  });

  it('returns nulls when nothing is detectable', () => {
    expect(resolveStackVersions({})).toEqual({
      phpMajor: null,
      nodeMajor: null,
      database: null,
      dbMajor: null,
    });
  });
});

describe('extractProjectFacets', () => {
  it('reads the detect-column shape ({ data: EnvDetectData })', () => {
    const facets = extractProjectFacets({
      data: {
        project: {
          framework: 'drupal',
          frameworkMajor: '11',
          packages: ['drupal/paragraphs@8'],
          primaryLanguage: 'php',
        },
        stack: { runtimeVersions: { php: '8.3', node: '20.1' } },
      },
    });
    expect(facets.framework).toEqual(['drupal']);
    expect(facets.frameworkMajor).toEqual(['11']);
    expect(facets.packages).toEqual(['drupal/paragraphs@8']);
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

  it('includes database/dbMajor and honors a confirmed PHP/DB override', () => {
    const facets = extractProjectFacets(
      {
        data: {
          project: { framework: 'general', primaryLanguage: 'php', packages: [] },
          stack: { runtimeVersions: {}, database: { type: 'mysql', version: null } },
        },
      },
      { phpVersion: '8.3', databaseType: 'mariadb', databaseVersion: '10.11' },
    );
    expect(facets.phpMajor).toEqual(['8']);
    expect(facets.database).toEqual(['mariadb']);
    expect(facets.dbMajor).toEqual(['10']);
    expect(facets.language).toEqual(['php']);
  });

  it('has empty datastore dims when the stack has no database', () => {
    const facets = extractProjectFacets({ data: { project: { framework: 'general' } } });
    expect(facets.database).toEqual([]);
    expect(facets.dbMajor).toEqual([]);
  });
});
