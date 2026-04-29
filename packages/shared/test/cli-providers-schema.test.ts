import { describe, expect, it } from 'vitest';
import {
  createCliProviderRequestSchema,
  updateCliProviderRequestSchema,
} from '../src/schemas/cli-providers.js';

const BASE_VALID = {
  name: 'gemini' as const,
  label: 'My Gemini',
  authMode: 'subscription' as const,
};

describe('createCliProviderRequestSchema isolateAuth', () => {
  it('omits isolateAuth from a minimal valid create payload', () => {
    const parsed = createCliProviderRequestSchema.parse(BASE_VALID);
    expect(parsed.isolateAuth).toBeUndefined();
  });

  it('accepts isolateAuth=true', () => {
    const parsed = createCliProviderRequestSchema.parse({ ...BASE_VALID, isolateAuth: true });
    expect(parsed.isolateAuth).toBe(true);
  });

  it('accepts isolateAuth=false', () => {
    const parsed = createCliProviderRequestSchema.parse({ ...BASE_VALID, isolateAuth: false });
    expect(parsed.isolateAuth).toBe(false);
  });

  it('rejects non-boolean isolateAuth', () => {
    expect(() =>
      createCliProviderRequestSchema.parse({ ...BASE_VALID, isolateAuth: 'yes' }),
    ).toThrow();
  });
});

describe('updateCliProviderRequestSchema isolateAuth', () => {
  it('accepts isolateAuth alone in a partial update', () => {
    const parsed = updateCliProviderRequestSchema.parse({ isolateAuth: true });
    expect(parsed.isolateAuth).toBe(true);
  });

  it('accepts an empty patch (all fields optional)', () => {
    const parsed = updateCliProviderRequestSchema.parse({});
    expect(parsed.isolateAuth).toBeUndefined();
  });
});
