import { describe, expect, it } from 'vitest';
import {
  adaptRetrievalProtocol,
  ddevConfigGuidanceLines,
  buildRetrievalGuidance,
  retrievalGuidanceLines,
  retrievalGuidanceLinesFor,
  type RetrievalAxes,
} from './_retrieval-guidance.js';

const AXES: RetrievalAxes[] = [
  { supportsLsp: true, ragWired: true },
  { supportsLsp: true, ragWired: false },
  { supportsLsp: false, ragWired: true },
  { supportsLsp: false, ragWired: false },
];

describe('buildRetrievalGuidance', () => {
  // Six splice sites join with `.filter(Boolean)` and nine without. An empty element would
  // therefore render the "same" block two different ways, and the dispatch-time replaceAll
  // would match only one of them — half the prompts silently keeping the wrong arm.
  it('emits no empty line in any variant', () => {
    for (const axes of AXES) {
      expect(buildRetrievalGuidance(axes).every((line) => line.length > 0)).toBe(true);
    }
  });

  it('starts every variant at 1. so it drops into a caller-numbered list', () => {
    for (const axes of AXES) {
      expect(buildRetrievalGuidance(axes)[0]?.startsWith('1. ')).toBe(true);
    }
  });

  it('never names rag_search in a rag-off variant', () => {
    for (const axes of AXES.filter((a) => !a.ragWired)) {
      expect(buildRetrievalGuidance(axes).join('\n')).not.toContain('rag_search');
    }
  });

  it('never names LSP in a no-LSP variant', () => {
    for (const axes of AXES.filter((a) => !a.supportsLsp)) {
      expect(buildRetrievalGuidance(axes).join('\n')).not.toContain('LSP');
    }
  });

  it('keeps discovery and grounding as separate steps in every variant', () => {
    for (const axes of AXES) {
      const text = buildRetrievalGuidance(axes).join('\n');
      expect(text).toContain('GROUND every lead');
      expect(text).toMatch(axes.ragWired ? /DISCOVER with `rag_search`/ : /LOCATE with/);
    }
  });

  it('renders the canonical arm for prompt builders', () => {
    expect(retrievalGuidanceLines()).toEqual(
      buildRetrievalGuidance({ supportsLsp: true, ragWired: true }),
    );
  });

  // Agent definition files outlive any one run and cannot know a future task's rag mode,
  // so they render the rag-on arm; the surface block contradicts them when it is absent.
  it('renders the rag-on arm for the agent file writers', () => {
    for (const supportsLsp of [true, false]) {
      expect(retrievalGuidanceLinesFor(supportsLsp)).toEqual(
        buildRetrievalGuidance({ supportsLsp, ragWired: true }),
      );
    }
  });
});

describe('adaptRetrievalProtocol', () => {
  const canonical = retrievalGuidanceLines().join('\n');

  it('leaves the canonical arm untouched', () => {
    const prompt = `before\n${canonical}\nafter`;
    expect(adaptRetrievalProtocol(prompt, { supportsLsp: true, ragWired: true })).toBe(prompt);
  });

  it.each(AXES.slice(1))('rewrites the canonical arm for %o', (axes) => {
    const prompt = `before\n${canonical}\nafter`;
    const adapted = adaptRetrievalProtocol(prompt, axes);
    expect(adapted).toBe(`before\n${buildRetrievalGuidance(axes).join('\n')}\nafter`);
  });

  // The old implementation returned early whenever LSP was on, so this cell was skipped —
  // and it is a live one: every claude-family provider on a repo with `ragMode: 'none'`.
  it('rewrites for an LSP-capable provider whose repo has no index', () => {
    const adapted = adaptRetrievalProtocol(canonical, { supportsLsp: true, ragWired: false });
    expect(adapted).not.toContain('rag_search');
    expect(adapted).toContain('LOCATE with LSP + grep');
  });

  it('rewrites every occurrence, not just the first', () => {
    const prompt = [canonical, 'middle', canonical].join('\n');
    const axes = { supportsLsp: false, ragWired: false };
    const adapted = adaptRetrievalProtocol(prompt, axes);
    expect(adapted.split(buildRetrievalGuidance(axes).join('\n'))).toHaveLength(3);
  });

  it('leaves surrounding prose alone', () => {
    const prompt = 'The task may legitimately discuss LSP and rag_search architecture.';
    expect(adaptRetrievalProtocol(prompt, { supportsLsp: false, ragWired: false })).toBe(prompt);
  });
});

describe('ddevConfigGuidanceLines', () => {
  it('emits the rule when the work mentions DDEV', () => {
    const lines = ddevConfigGuidanceLines('Add DDEV to this Drupal site');
    expect(lines.join('\n')).toContain('ddev_version_constraint');
    expect(lines.join('\n')).toContain('>= v1.24.0 < v2.0.0');
  });

  it('matches case-insensitively', () => {
    expect(ddevConfigGuidanceLines('add ddev').length).toBeGreaterThan(0);
    expect(ddevConfigGuidanceLines('Configure DDev locally').length).toBeGreaterThan(0);
  });

  it('stays out of prompts that have nothing to do with DDEV', () => {
    // The lines are pure prompt weight for such a task, and the runtime repair in
    // sandbox/ddev-version-constraint.ts is what actually guarantees the outcome.
    expect(ddevConfigGuidanceLines('Add a logout button to the header')).toEqual([]);
    expect(ddevConfigGuidanceLines('')).toEqual([]);
  });

  it('does not fire on a word that merely contains "ddev"', () => {
    expect(ddevConfigGuidanceLines('refactor the middevice adapter')).toEqual([]);
  });
});
