import { describe, expect, it } from 'vitest';
import { COMPOSED_IMAGE_REFS_KEY, parseImageReferences } from '../src/lsp/composed-image-refs.js';

describe('retained composed image reference parsing', () => {
  it('accepts the injectable boundary and rejects an extra provider', () => {
    const refs = { schemaVersion: 1, entries: [{ providerId: 'p1' }, { providerId: 'p2' }] };
    const metadata = { [COMPOSED_IMAGE_REFS_KEY]: refs };
    expect(parseImageReferences(metadata, 2)).toEqual(refs);
    refs.entries.push({ providerId: 'p3' });
    expect(() => parseImageReferences(metadata, 2)).toThrow(
      'Invalid retained composed image references',
    );
    expect(parseImageReferences(metadata)).toEqual(refs);
  });
});
