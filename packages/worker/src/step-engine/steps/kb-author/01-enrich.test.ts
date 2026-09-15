import { describe, expect, it } from 'vitest';
import {
  buildEnrichPrompt,
  cleanFacets,
  kbAuthorEnrichStep,
  mergeAuthorFacets,
  normCategory,
  parseEnrichment,
  resolveWriteTarget,
} from './01-enrich.js';

describe('parseEnrichment', () => {
  it('parses a fenced json block out of CLI text', () => {
    const text =
      'sure, here you go:\n```json\n{"mode":"new","title":"T","category":"tech_pattern","body":"# T"}\n```\nthanks';
    const r = parseEnrichment(text);
    expect(r?.mode).toBe('new');
    expect(r?.title).toBe('T');
    expect(r?.body).toBe('# T');
  });

  it('accepts an already-structured object (the bypass stub)', () => {
    const r = parseEnrichment({
      mode: 'new',
      title: 'X',
      category: 'general',
      facets: {},
      body: '# X',
    });
    expect(r?.body).toBe('# X');
  });

  it('returns null for unparseable input', () => {
    expect(parseEnrichment('no json here')).toBeNull();
    expect(parseEnrichment(42)).toBeNull();
  });
});

describe('normCategory', () => {
  it('keeps a valid category', () => {
    expect(normCategory('anti_pattern')).toBe('anti_pattern');
  });

  it('falls back to general for unknown or missing', () => {
    expect(normCategory('made_up')).toBe('general');
    expect(normCategory(undefined)).toBe('general');
  });
});

describe('cleanFacets', () => {
  it('keeps known dimensions, dedupes and drops empties', () => {
    const out = cleanFacets({ framework: ['drupal', 'drupal', ''], frameworkMajor: ['11'] });
    expect(out.framework).toEqual(['drupal']);
    expect(out.frameworkMajor).toEqual(['11']);
  });

  it('returns {} for empty or undefined', () => {
    expect(cleanFacets(undefined)).toEqual({});
    expect(cleanFacets({ framework: [] })).toEqual({});
  });
});

describe('resolveWriteTarget', () => {
  const ids = new Set(['a', 'b']);

  it('updates when the model returns a known targetId', () => {
    expect(resolveWriteTarget({ mode: 'update', targetId: 'b' }, 'skel', ids)).toEqual({
      isUpdate: true,
      targetId: 'b',
    });
  });

  it('falls back to inserting the skeleton when targetId is unknown', () => {
    expect(resolveWriteTarget({ mode: 'update', targetId: 'zzz' }, 'skel', ids)).toEqual({
      isUpdate: false,
      targetId: 'skel',
    });
  });

  it('inserts on mode new', () => {
    expect(resolveWriteTarget({ mode: 'new' }, 'skel', ids)).toEqual({
      isUpdate: false,
      targetId: 'skel',
    });
  });

  it('inserts when there is no parsed output', () => {
    expect(resolveWriteTarget(null, 'skel', ids)).toEqual({ isUpdate: false, targetId: 'skel' });
  });
});

// MEASURED on entry b15eebfb: notes describing a Drupal 8+ rule, authored against a Drupal 7
// repo, produced an audit of that one repo scoped `frameworkMajor: ["7"]` — the exact set of
// projects the rule does not apply to. The prompt asked for facets "you actually found in the
// repository" and for "real file paths… not generic advice", and the model obliged.
const baseDetect = {
  entryId: 'e1',
  namespace: 'default',
  title: 'Never inline SVG',
  seedText: 'inline SVGs bloat the page cache',
  existing: [],
  hasRepo: true,
  authorFacets: {},
};

describe('mergeAuthorFacets', () => {
  it('replaces a dimension the author stated, rather than unioning it', () => {
    // The failure this exists to stop: author says drupal, model says drupal 7. A union would
    // keep BOTH, and naming a dimension RESTRICTS the entry to it.
    const merged = mergeAuthorFacets(
      { framework: ['drupal'] },
      { framework: ['drupal'], frameworkMajor: ['7'] },
    );
    expect(merged.framework).toEqual(['drupal']);
    // ...and the model does NOT get to narrow it by version. Leaving the version box blank is
    // how the form says "every Drupal major", so the model's own `7` is cleared rather than
    // kept — see the version-dimension block below.
    expect(merged.frameworkMajor).toBeUndefined();
  });

  it('overrides the model on a dimension the author pinned', () => {
    const merged = mergeAuthorFacets({ frameworkMajor: ['8'] }, { frameworkMajor: ['7'] });
    expect(merged.frameworkMajor).toEqual(['8']);
  });

  it('leaves the model in charge when the author stated nothing', () => {
    const merged = mergeAuthorFacets({}, { framework: ['drupal'], language: ['php'] });
    expect(merged).toEqual({ framework: ['drupal'], language: ['php'] });
  });

  it('treats an empty dimension as unstated', () => {
    // `cleanFacets` drops empties, but an author form can post one — it means "no opinion",
    // not "scope this to nothing".
    const merged = mergeAuthorFacets({ framework: [] }, { framework: ['drupal'] });
    expect(merged.framework).toEqual(['drupal']);
  });
});

describe('buildEnrichPrompt', () => {
  // Counts have no detector and deliberately never will: nothing structural separates
  // "this codebase has 122 icons" from "eight icons per card is ~2.4 KB", and the difference
  // is the self-reference, not the number. MEASURED — the scrubber removes 0 of 29 blocks from
  // a real article carrying exactly that arithmetic, and a count rule would have taken it. So
  // the prompt is the ONLY thing holding this contract, which is why its wording is pinned.
  it('draws the line between measuring the repo and reasoning with numbers', () => {
    const p = buildEnrichPrompt(baseDetect);
    expect(p).toMatch(/count of occurrences/i);
    // Both sides must be present: the ban alone reads as "use no numbers" and would cost these
    // articles the arithmetic that makes a rule land.
    expect(p).toMatch(/bans MEASURING the repository, not using numbers/i);
    expect(p).toMatch(/illustrative/i);
  });

  it('never asks for facets from the repository', () => {
    const p = buildEnrichPrompt(baseDetect);
    expect(p).not.toMatch(/versions you actually found in the repository/i);
    expect(p).toMatch(/Facets describe the RULE/);
    // And says what omitting a dimension MEANS, since that is the reachability rule.
    expect(p).toMatch(/applies to all values/);
  });

  it('bans citations and asks for both sides of the example', () => {
    const p = buildEnrichPrompt(baseDetect);
    expect(p).toMatch(/NEVER cite a file path/);
    expect(p).toMatch(/## The wrong way/);
    expect(p).toMatch(/## The right way/);
    expect(p).toMatch(/ANTI-PATTERN — do not copy/);
    expect(p).not.toMatch(/Cite real file paths/);
  });

  it('tells an anchored run the repo is to read, not to quote', () => {
    const p = buildEnrichPrompt(baseDetect);
    expect(p).toMatch(/NOT the subject of the article/);
    expect(p).toMatch(/Do NOT read the scope off the repository/);
  });

  it('sends a repo-less run after nothing on disk', () => {
    const p = buildEnrichPrompt({ ...baseDetect, hasRepo: false });
    expect(p).toMatch(/NO repository is checked out/);
    // The retrieval block and the anchored task line both assume a checkout.
    expect(p).not.toMatch(/THIS repository/);
    expect(p).not.toMatch(/rag_search/);
  });

  it('states an author-set scope as authoritative, and omits the block otherwise', () => {
    const withScope = buildEnrichPrompt({
      ...baseDetect,
      authorFacets: { framework: ['drupal'] },
    });
    expect(withScope).toMatch(/AUTHORITATIVE — do not narrow or widen it/);
    expect(withScope).toMatch(/- framework: drupal/);
    expect(buildEnrichPrompt(baseDetect)).not.toMatch(/AUTHORITATIVE/);
  });
});

// The form promises a blank version box means "every version". Without clearing the child the
// model's own guess survived there, so scoping `framework: ['drupal']` against a Drupal 7
// checkout still produced `frameworkMajor: ['7']` — the regression this step exists to stop.
describe('mergeAuthorFacets and version dimensions', () => {
  it("drops the model's major when the author scoped the technology", () => {
    const merged = mergeAuthorFacets(
      { framework: ['drupal'] },
      { framework: ['drupal'], frameworkMajor: ['7'], language: ['php'] },
    );
    expect(merged.frameworkMajor).toBeUndefined();
    expect(merged.framework).toEqual(['drupal']);
    // An unrelated dimension the author said nothing about is still the model's to fill.
    expect(merged.language).toEqual(['php']);
  });

  it('keeps a version the author stated themselves', () => {
    const merged = mergeAuthorFacets(
      { framework: ['drupal'], frameworkMajor: ['11'] },
      { frameworkMajor: ['7'] },
    );
    expect(merged.frameworkMajor).toEqual(['11']);
  });

  it('leaves the model alone when the author scoped nothing', () => {
    const model = { framework: ['drupal'], frameworkMajor: ['7'] };
    expect(mergeAuthorFacets({}, model)).toEqual(model);
  });

  it('covers the language and database parents too', () => {
    expect(
      mergeAuthorFacets({ language: ['php'] }, { phpMajor: ['8'], nodeMajor: ['22'] }),
    ).toEqual({ language: ['php'] });
    expect(mergeAuthorFacets({ database: ['postgres'] }, { dbMajor: ['17'] })).toEqual({
      database: ['postgres'],
    });
  });
});

// The scrub must not fail OPEN when the violation is total. Restoring the raw text on an
// empty scrub handed the shared store a draft that was nothing but citations, and its
// `scrubbed` list would then contradict the body the reviewer was shown.
describe('an article that scrubs to nothing', () => {
  const detected = {
    entryId: '11111111-1111-4111-8111-111111111111',
    title: 'All citations',
    seedText: 'seed',
    authorFacets: {},
    hasRepo: false,
    existing: [],
  } as unknown as Parameters<typeof kbAuthorEnrichStep.apply>[1]['detected'];

  // Every block is a slashed path reference, which counts in either mode, so the scrub empties
  // the article without needing a repository to resolve against.
  const llmOutput = JSON.stringify({
    mode: 'new',
    category: 'general',
    facets: {},
    body: 'See src/Cache/Backend.php:12 for this.\n\nAnd web/modules/custom/acme/acme.module:9 too.',
  });

  const ctx = { repoPath: '/nonexistent', logger: { warn() {}, info() {} } } as never;

  it('retries rather than publishing it, while attempts remain', async () => {
    await expect(
      kbAuthorEnrichStep.apply!(ctx, { detected, llmOutput, isFinalLlmAttempt: false } as never),
    ).rejects.toThrow(/scrubbed to nothing/i);
  });

  it('fails on the final attempt instead of restoring the raw text', async () => {
    await expect(
      kbAuthorEnrichStep.apply!(ctx, { detected, llmOutput, isFinalLlmAttempt: true } as never),
    ).rejects.toThrow(/no publishable article/i);
  });
});
