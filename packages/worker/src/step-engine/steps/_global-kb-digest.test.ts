import { describe, expect, it, vi } from 'vitest';
import { emptyProjectFacetSet, type ProjectFacetSet } from '@haive/shared/global-kb';
import {
  facetsMatchProject,
  globalKbDigestPrompt,
  resolveGlobalKbDigest,
  withGlobalKbDigest,
  type GlobalKbDigestEntry,
} from './_global-kb-digest.js';

// The digest runs on the dispatch path, so an unreachable global KB must cost
// nothing but the digest. Mocked to throw because that is the one behaviour a
// regression here would break silently across every task.
vi.mock('@haive/shared/global-kb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared/global-kb')>();
  return {
    ...actual,
    resolveTaskFacets: async () => actual.emptyProjectFacetSet(),
    withGlobalKb: async () => {
      throw new Error('global KB unreachable');
    },
  };
});

function projectFacets(overrides: Partial<ProjectFacetSet> = {}): ProjectFacetSet {
  return { ...emptyProjectFacetSet(), ...overrides };
}

describe('facetsMatchProject', () => {
  it('includes an entry that constrains nothing', () => {
    expect(facetsMatchProject({}, projectFacets({ language: ['php'] }))).toBe(true);
  });

  it('includes an entry whose dimension is present but empty', () => {
    expect(facetsMatchProject({ language: [] }, projectFacets({ language: ['php'] }))).toBe(true);
  });

  it('includes an entry that shares a value with the project', () => {
    expect(facetsMatchProject({ language: ['php'] }, projectFacets({ language: ['php'] }))).toBe(
      true,
    );
  });

  it('matches case-insensitively', () => {
    expect(facetsMatchProject({ language: ['PHP'] }, projectFacets({ language: ['php'] }))).toBe(
      true,
    );
  });

  it('excludes an entry constraining a dimension the project does not have', () => {
    expect(facetsMatchProject({ language: ['php'] }, projectFacets())).toBe(false);
  });

  it('excludes an entry that disagrees on a constrained dimension', () => {
    expect(facetsMatchProject({ phpMajor: ['8'] }, projectFacets({ phpMajor: ['5'] }))).toBe(false);
  });

  it('requires EVERY constrained dimension to match, not just one', () => {
    const entry = { language: ['php'], phpMajor: ['8'] };
    const project = projectFacets({ language: ['php'], phpMajor: ['5'] });
    expect(facetsMatchProject(entry, project)).toBe(false);
  });

  it('treats a null facet object as universal', () => {
    expect(facetsMatchProject(null, projectFacets({ language: ['php'] }))).toBe(true);
  });
});

describe('globalKbDigestPrompt', () => {
  const entries: GlobalKbDigestEntry[] = [
    { title: 'DDEV post-start hooks cannot inject settings', category: 'tech_pattern' },
    { title: 'Installing a PHP extension in a DDEV web image', category: 'tech_pattern' },
    { title: 'DDEV with docroot at the repo root exposes .ddev/', category: 'anti_pattern' },
  ];

  it('groups titles under their category', () => {
    const out = globalKbDigestPrompt(entries);
    expect(out).toContain('tech_pattern:');
    expect(out).toContain('anti_pattern:');
    expect(out).toContain('- DDEV post-start hooks cannot inject settings');
  });

  it('points the agent at rag_search as the only way to read a body', () => {
    expect(globalKbDigestPrompt(entries)).toContain('rag_search');
  });
});

describe('resolveGlobalKbDigest', () => {
  it('returns an empty digest when the global KB throws, never rejecting', async () => {
    await expect(resolveGlobalKbDigest({} as never, 'task-1')).resolves.toEqual([]);
  });
});

describe('withGlobalKbDigest', () => {
  const entries: GlobalKbDigestEntry[] = [{ title: 'A house standard', category: 'best_practice' }];

  it('prepends the digest to the prompt', () => {
    const out = withGlobalKbDigest('DO THE WORK', entries);
    expect(out).toContain('A house standard');
    expect(out.endsWith('DO THE WORK')).toBe(true);
  });

  it('adds nothing for an empty digest', () => {
    expect(withGlobalKbDigest('DO THE WORK', [])).toBe('DO THE WORK');
  });

  it('is idempotent so nested builders cannot double-inject', () => {
    const once = withGlobalKbDigest('DO THE WORK', entries);
    expect(withGlobalKbDigest(once, entries)).toBe(once);
  });
});
