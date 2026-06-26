import { describe, expect, it } from 'vitest';
import {
  confirmSupersedeByEmbedding,
  pickBestSupersedeMatch,
  SUPERSEDE_SIMILARITY_THRESHOLD,
} from './_global-kb-similarity.js';

describe('pickBestSupersedeMatch', () => {
  it('returns null for an empty candidate set', () => {
    expect(pickBestSupersedeMatch([])).toBeNull();
  });

  it('returns null when every candidate is below threshold', () => {
    expect(
      pickBestSupersedeMatch([
        { id: 'a', status: 'active', sim: 0.5 },
        { id: 'b', status: 'draft', sim: 0.71 },
      ]),
    ).toBeNull();
  });

  it('picks a single above-threshold candidate', () => {
    expect(pickBestSupersedeMatch([{ id: 'a', status: 'active', sim: 0.9 }])).toBe('a');
  });

  it('treats sim exactly at the threshold as eligible', () => {
    expect(
      pickBestSupersedeMatch([{ id: 'a', status: 'active', sim: SUPERSEDE_SIMILARITY_THRESHOLD }]),
    ).toBe('a');
  });

  it('prefers an eligible active entry over a higher-sim draft', () => {
    expect(
      pickBestSupersedeMatch([
        { id: 'draft', status: 'draft', sim: 0.95 },
        { id: 'active', status: 'active', sim: 0.8 },
      ]),
    ).toBe('active');
  });

  it('among same status, the highest similarity wins', () => {
    expect(
      pickBestSupersedeMatch([
        { id: 'lo', status: 'active', sim: 0.8 },
        { id: 'hi', status: 'active', sim: 0.91 },
      ]),
    ).toBe('hi');
  });

  it('falls back to a draft when no active clears the bar', () => {
    expect(
      pickBestSupersedeMatch([
        { id: 'draft', status: 'draft', sim: 0.85 },
        { id: 'active', status: 'active', sim: 0.4 },
      ]),
    ).toBe('draft');
  });
});

describe('confirmSupersedeByEmbedding (safe defaults, no network)', () => {
  const cand = [{ id: 'a', status: 'active', text: 'something' }];

  it('returns null when ollama is not configured (never calls embed)', async () => {
    expect(
      await confirmSupersedeByEmbedding({ ollamaUrl: null, embedModel: null }, 'new', cand),
    ).toBeNull();
    expect(
      await confirmSupersedeByEmbedding(
        { ollamaUrl: 'http://ollama:11434', embedModel: null },
        'new',
        cand,
      ),
    ).toBeNull();
  });

  it('returns null when there are no candidates', async () => {
    expect(
      await confirmSupersedeByEmbedding(
        { ollamaUrl: 'http://ollama:11434', embedModel: 'm' },
        'new',
        [],
      ),
    ).toBeNull();
  });
});
