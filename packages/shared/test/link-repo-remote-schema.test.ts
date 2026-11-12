import { describe, expect, it } from 'vitest';
import { linkRepoRemoteRequestSchema } from '../src/schemas/repos.js';

describe('remote credential selection', () => {
  const remoteUrl = 'https://example.test/repo.git';
  it('accepts an explicit clear', () => {
    expect(linkRepoRemoteRequestSchema.parse({ remoteUrl, credentialsId: null })).toEqual({
      remoteUrl,
      credentialsId: null,
    });
  });
  it('preserves omission and a chosen credential id', () => {
    expect(linkRepoRemoteRequestSchema.parse({ remoteUrl })).toEqual({ remoteUrl });
    const credentialsId = '00000000-0000-4000-8000-0000000000c1';
    expect(linkRepoRemoteRequestSchema.parse({ remoteUrl, credentialsId }).credentialsId).toBe(
      credentialsId,
    );
  });
});
