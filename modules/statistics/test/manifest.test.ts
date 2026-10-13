import { describe, expect, it } from 'vitest';
import { moduleManifestSchema } from '@haive/shared/modularity';
import manifest from '../src/manifest.js';

describe('statistics manifest', () => {
  it('parses against the manifest schema', () => {
    expect(() => moduleManifestSchema.parse(manifest)).not.toThrow();
  });

  it('defaults the time window to 30d with a select field of the page presets', () => {
    const parsed = moduleManifestSchema.parse(manifest);
    expect(parsed.globalSettings?.defaults).toEqual({ defaultWindow: '30d' });
    const field = parsed.globalSettings?.form.fields.find((f) => f.id === 'defaultWindow');
    expect(field?.type).toBe('select');
    if (field?.type !== 'select') throw new Error('defaultWindow is not a select');
    expect(field.label).toBe('Default time window');
    expect(field.options.map((o) => o.value)).toEqual(['7d', '30d', '90d', '1y', 'all']);
  });
});
