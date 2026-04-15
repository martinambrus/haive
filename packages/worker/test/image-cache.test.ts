import { describe, expect, it } from 'vitest';
import { renderDockerfile, resolveImageTag } from '../src/sandbox/image-cache.js';

const baseParams = {
  name: 'claude-code' as const,
  cliVersion: '1.2.3',
  providerId: 'provider-abc',
};

describe('resolveImageTag', () => {
  it('returns null when CLI has no install lines and no extras are present', () => {
    const result = resolveImageTag({
      name: 'grok',
      cliVersion: null,
      providerId: 'provider-x',
      sandboxDockerfileExtra: null,
    });
    expect(result).toBeNull();
  });

  it('produces a shared, version-pinned tag when only install lines are present', () => {
    const result = resolveImageTag({
      ...baseParams,
      sandboxDockerfileExtra: null,
    });
    expect(result).not.toBeNull();
    expect(result!.shared).toBe(true);
    expect(result!.tag).toBe('haive-cli-sandbox:claude-code-1.2.3');
  });

  it('falls back to "installer" segment when cliVersion is null for a pinnable CLI', () => {
    const result = resolveImageTag({
      ...baseParams,
      cliVersion: null,
      sandboxDockerfileExtra: null,
    });
    expect(result!.tag).toBe('haive-cli-sandbox:claude-code-installer');
  });

  it('uses the piggyback target name for a piggyback CLI (zai -> claude-code)', () => {
    const result = resolveImageTag({
      name: 'zai',
      cliVersion: '9.9.9',
      providerId: 'provider-zai',
      sandboxDockerfileExtra: null,
    });
    expect(result!.shared).toBe(true);
    expect(result!.tag).toBe('haive-cli-sandbox:claude-code-9.9.9');
  });

  it('embeds custom Dockerfile extras verbatim in the rendered Dockerfile', () => {
    const extra = [
      'RUN apk add --no-cache python3 make g++',
      'RUN git clone https://example.com/repo /opt/repo',
      'WORKDIR /opt/repo',
      'RUN npm install',
    ].join('\n');
    const result = resolveImageTag({
      ...baseParams,
      sandboxDockerfileExtra: extra,
    });
    const dockerfile = renderDockerfile(result!);
    expect(dockerfile).toContain('RUN apk add --no-cache python3 make g++');
    expect(dockerfile).toContain('RUN git clone https://example.com/repo /opt/repo');
    expect(dockerfile).toContain('WORKDIR /opt/repo');
    expect(dockerfile).toContain('RUN npm install');
  });

  it('keeps extras ordered after the CLI install block in the rendered Dockerfile', () => {
    const extra = 'RUN echo extras-marker';
    const result = resolveImageTag({
      ...baseParams,
      sandboxDockerfileExtra: extra,
    });
    const dockerfile = renderDockerfile(result!);
    const cliIdx = dockerfile.indexOf('npm install -g @anthropic-ai/claude-code');
    const extraIdx = dockerfile.indexOf('RUN echo extras-marker');
    expect(cliIdx).toBeGreaterThanOrEqual(0);
    expect(extraIdx).toBeGreaterThan(cliIdx);
  });

  it('marks a provider-scoped (non-shared) tag when extras are present', () => {
    const result = resolveImageTag({
      ...baseParams,
      sandboxDockerfileExtra: 'RUN echo hi',
    });
    expect(result!.shared).toBe(false);
    expect(result!.tag).toMatch(/^haive-cli-sandbox:provider-provider-abc-[0-9a-f]{16}$/);
  });

  it('produces the same tag for identical extras (cache hit on no-op edit)', () => {
    const a = resolveImageTag({
      ...baseParams,
      sandboxDockerfileExtra: 'RUN echo stable',
    });
    const b = resolveImageTag({
      ...baseParams,
      sandboxDockerfileExtra: 'RUN echo stable',
    });
    expect(a!.tag).toBe(b!.tag);
  });

  it('produces a different tag when sandboxDockerfileExtra changes (regression guard for stale-cache bug)', () => {
    const original = resolveImageTag({
      ...baseParams,
      sandboxDockerfileExtra: 'RUN npm install && npm link',
    });
    const edited = resolveImageTag({
      ...baseParams,
      sandboxDockerfileExtra: 'RUN npm install\nRUN npm link',
    });
    expect(original!.tag).not.toBe(edited!.tag);
  });

  it('produces a different tag when the CLI version changes while extras stay the same', () => {
    const v1 = resolveImageTag({
      ...baseParams,
      cliVersion: '1.2.3',
      sandboxDockerfileExtra: 'RUN echo extras',
    });
    const v2 = resolveImageTag({
      ...baseParams,
      cliVersion: '9.9.9',
      sandboxDockerfileExtra: 'RUN echo extras',
    });
    expect(v1!.tag).not.toBe(v2!.tag);
  });

  it('treats whitespace-only extras as empty and returns the shared install tag', () => {
    const result = resolveImageTag({
      ...baseParams,
      sandboxDockerfileExtra: '   \n  \n',
    });
    expect(result!.shared).toBe(true);
    expect(result!.tag).toBe('haive-cli-sandbox:claude-code-1.2.3');
  });

  it('produces different tags for two providers even when extras content is identical', () => {
    const providerA = resolveImageTag({
      ...baseParams,
      providerId: 'provider-a',
      sandboxDockerfileExtra: 'RUN echo shared',
    });
    const providerB = resolveImageTag({
      ...baseParams,
      providerId: 'provider-b',
      sandboxDockerfileExtra: 'RUN echo shared',
    });
    expect(providerA!.tag).not.toBe(providerB!.tag);
    expect(providerA!.tag).toContain('provider-a-');
    expect(providerB!.tag).toContain('provider-b-');
  });
});
