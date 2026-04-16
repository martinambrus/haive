import { describe, expect, it } from 'vitest';
import { SANDBOX_CORE_IMAGE, composeSandboxImage } from '../src/sandbox/image-composer.js';

const claudeCodeProvider = {
  name: 'claude-code' as const,
  cliVersion: '1.2.3',
  sandboxDockerfileExtra: null,
};

describe('composeSandboxImage', () => {
  it('uses the sandbox-core FROM line when no env-template is provided', () => {
    const result = composeSandboxImage({
      envTemplateDockerfile: null,
      provider: claudeCodeProvider,
    });
    expect(result.dockerfileBody.startsWith(`FROM ${SANDBOX_CORE_IMAGE}`)).toBe(true);
    expect(result.hasEnvTemplate).toBe(false);
    expect(result.hasCliInstall).toBe(true);
    expect(result.hasExtras).toBe(false);
  });

  it('uses the env-template body as the base when one is provided', () => {
    const envDockerfile = 'FROM ubuntu:24.04\nRUN apt-get install -y git\n';
    const result = composeSandboxImage({
      envTemplateDockerfile: envDockerfile,
      provider: claudeCodeProvider,
    });
    expect(result.dockerfileBody.startsWith('FROM ubuntu:24.04')).toBe(true);
    expect(result.dockerfileBody).not.toContain(SANDBOX_CORE_IMAGE);
    expect(result.dockerfileBody).toContain('RUN apt-get install -y git');
    expect(result.hasEnvTemplate).toBe(true);
  });

  it('stacks env-template, CLI install lines, and extras in that order', () => {
    const envDockerfile = 'FROM ubuntu:24.04\n';
    const result = composeSandboxImage({
      envTemplateDockerfile: envDockerfile,
      provider: {
        name: 'claude-code',
        cliVersion: '1.2.3',
        sandboxDockerfileExtra: 'RUN apk add --no-cache jq',
      },
    });
    const baseIdx = result.dockerfileBody.indexOf('FROM ubuntu:24.04');
    const cliIdx = result.dockerfileBody.indexOf('npm install -g @anthropic-ai/claude-code');
    const extraIdx = result.dockerfileBody.indexOf('RUN apk add --no-cache jq');
    expect(baseIdx).toBeGreaterThanOrEqual(0);
    expect(cliIdx).toBeGreaterThan(baseIdx);
    expect(extraIdx).toBeGreaterThan(cliIdx);
    expect(result.hasExtras).toBe(true);
  });

  it('emits an npm install line that pins the requested CLI version', () => {
    const result = composeSandboxImage({
      envTemplateDockerfile: null,
      provider: { name: 'claude-code', cliVersion: '1.2.3', sandboxDockerfileExtra: null },
    });
    expect(result.dockerfileBody).toContain('@anthropic-ai/claude-code@1.2.3');
  });

  it('omits the version pin when cliVersion is null', () => {
    const result = composeSandboxImage({
      envTemplateDockerfile: null,
      provider: { name: 'claude-code', cliVersion: null, sandboxDockerfileExtra: null },
    });
    expect(result.dockerfileBody).toContain('npm install -g @anthropic-ai/claude-code ');
    expect(result.dockerfileBody).not.toContain('@anthropic-ai/claude-code@');
  });

  it('emits a curl-script line for curl-script CLIs (kiro)', () => {
    const result = composeSandboxImage({
      envTemplateDockerfile: null,
      provider: { name: 'kiro', cliVersion: null, sandboxDockerfileExtra: null },
    });
    expect(result.dockerfileBody).toContain('curl -fsSL https://cli.kiro.dev/install');
    expect(result.hasCliInstall).toBe(true);
  });

  it('delegates a piggyback CLI (zai) to its target install', () => {
    const result = composeSandboxImage({
      envTemplateDockerfile: null,
      provider: { name: 'zai', cliVersion: '1.0.0', sandboxDockerfileExtra: null },
    });
    expect(result.dockerfileBody).toContain('@anthropic-ai/claude-code@1.0.0');
  });

  it('omits CLI install lines for an unsupported CLI (grok)', () => {
    const result = composeSandboxImage({
      envTemplateDockerfile: null,
      provider: { name: 'grok', cliVersion: null, sandboxDockerfileExtra: null },
    });
    expect(result.hasCliInstall).toBe(false);
    expect(result.dockerfileBody).not.toContain('RUN npm install');
    expect(result.dockerfileBody).not.toContain('RUN curl');
  });

  it('produces deterministic content-hash tags for identical inputs', () => {
    const a = composeSandboxImage({
      envTemplateDockerfile: 'FROM ubuntu:24.04\n',
      provider: claudeCodeProvider,
    });
    const b = composeSandboxImage({
      envTemplateDockerfile: 'FROM ubuntu:24.04\n',
      provider: claudeCodeProvider,
    });
    expect(a.tag).toBe(b.tag);
    expect(a.hash).toBe(b.hash);
    expect(a.dockerfileBody).toBe(b.dockerfileBody);
  });

  it('produces different tags when inputs differ', () => {
    const a = composeSandboxImage({
      envTemplateDockerfile: 'FROM ubuntu:24.04\n',
      provider: claudeCodeProvider,
    });
    const b = composeSandboxImage({
      envTemplateDockerfile: 'FROM debian:12\n',
      provider: claudeCodeProvider,
    });
    const c = composeSandboxImage({
      envTemplateDockerfile: 'FROM ubuntu:24.04\n',
      provider: { name: 'claude-code', cliVersion: '9.9.9', sandboxDockerfileExtra: null },
    });
    expect(a.tag).not.toBe(b.tag);
    expect(a.tag).not.toBe(c.tag);
    expect(b.tag).not.toBe(c.tag);
  });

  it('produces a tag prefixed with haive-sandbox and 16 hex chars', () => {
    const result = composeSandboxImage({
      envTemplateDockerfile: null,
      provider: claudeCodeProvider,
    });
    expect(result.tag).toMatch(/^haive-sandbox:[0-9a-f]{16}$/);
    expect(result.hash).toHaveLength(16);
  });

  it('trims trailing whitespace on the env-template body so the composition is stable', () => {
    const a = composeSandboxImage({
      envTemplateDockerfile: 'FROM ubuntu:24.04\n',
      provider: claudeCodeProvider,
    });
    const b = composeSandboxImage({
      envTemplateDockerfile: 'FROM ubuntu:24.04\n\n\n',
      provider: claudeCodeProvider,
    });
    expect(a.tag).toBe(b.tag);
  });

  it('treats empty string extras the same as null extras', () => {
    const a = composeSandboxImage({
      envTemplateDockerfile: null,
      provider: { name: 'claude-code', cliVersion: '1.2.3', sandboxDockerfileExtra: '   ' },
    });
    const b = composeSandboxImage({
      envTemplateDockerfile: null,
      provider: { name: 'claude-code', cliVersion: '1.2.3', sandboxDockerfileExtra: null },
    });
    expect(a.tag).toBe(b.tag);
    expect(a.hasExtras).toBe(false);
  });
});
