import { describe, expect, it } from 'vitest';
import { composeSandboxImage } from '../src/sandbox/image-composer.js';

const baseInput = {
  envTemplateDockerfile: 'FROM debian:12-slim\nRUN echo project',
  provider: { name: 'claude-code' as const, cliVersion: null, sandboxDockerfileExtra: null },
  baseImageId: null,
};

describe('composeSandboxImage RTK version pin', () => {
  it('bakes the default rtk version with checksums.txt verification when unpinned', () => {
    const c = composeSandboxImage({ ...baseInput });
    expect(c.dockerfileBody).toContain('releases/download/v0.37.2/');
    expect(c.dockerfileBody).toContain('checksums.txt');
    expect(c.dockerfileBody).toContain('sha256sum -c -');
  });

  it('bakes a pinned rtk version and changes the composition hash (forces rebuild)', () => {
    const def = composeSandboxImage({ ...baseInput });
    const pinned = composeSandboxImage({ ...baseInput, rtkVersion: '0.42.4' });
    expect(pinned.dockerfileBody).toContain('releases/download/v0.42.4/');
    expect(pinned.dockerfileBody).not.toContain('releases/download/v0.37.2/');
    expect(pinned.hash).not.toBe(def.hash);
  });

  it('treats null/empty/whitespace rtkVersion as the default (same hash)', () => {
    const a = composeSandboxImage({ ...baseInput, rtkVersion: null });
    const b = composeSandboxImage({ ...baseInput });
    const c = composeSandboxImage({ ...baseInput, rtkVersion: '   ' });
    expect(a.hash).toBe(b.hash);
    expect(c.hash).toBe(b.hash);
  });
});
