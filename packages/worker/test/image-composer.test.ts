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

  it('delegates a piggyback CLI (zai) to its target install', () => {
    const result = composeSandboxImage({
      envTemplateDockerfile: null,
      provider: { name: 'zai', cliVersion: '1.0.0', sandboxDockerfileExtra: null },
    });
    expect(result.dockerfileBody).toContain('@anthropic-ai/claude-code@1.0.0');
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

  describe('haive runtime tools layer', () => {
    // Composer always injects an idempotent install layer for tools the
    // CLI session relies on but env-templates won't necessarily ship —
    // currently uv (for the mcp-server-git MCP server) and ripgrep (for
    // gemini's GrepTool, which prints "Ripgrep is not available" otherwise).
    it('injects the runtime tools layer between base and CLI install lines', () => {
      const result = composeSandboxImage({
        envTemplateDockerfile: 'FROM ubuntu:24.04\n',
        provider: claudeCodeProvider,
      });
      const baseIdx = result.dockerfileBody.indexOf('FROM ubuntu:24.04');
      const layerIdx = result.dockerfileBody.indexOf('command -v uvx');
      const cliIdx = result.dockerfileBody.indexOf('npm install -g @anthropic-ai/claude-code');
      expect(baseIdx).toBeGreaterThanOrEqual(0);
      expect(layerIdx).toBeGreaterThan(baseIdx);
      expect(cliIdx).toBeGreaterThan(layerIdx);
    });

    it('installs ripgrep and uv on alpine (apk) bases', () => {
      const result = composeSandboxImage({
        envTemplateDockerfile: null,
        provider: claudeCodeProvider,
      });
      expect(result.dockerfileBody).toContain('apk add --no-cache uv ripgrep');
    });

    it('installs ripgrep on debian/ubuntu (apt) bases and falls through to the official uv installer', () => {
      const result = composeSandboxImage({
        envTemplateDockerfile: 'FROM ubuntu:24.04\n',
        provider: claudeCodeProvider,
      });
      expect(result.dockerfileBody).toContain('apt-get install -y --no-install-recommends');
      expect(result.dockerfileBody).toContain('ripgrep');
      expect(result.dockerfileBody).toContain('astral.sh/uv/install.sh');
    });

    it('short-circuits the install when both uvx AND rg are already on PATH', () => {
      const result = composeSandboxImage({
        envTemplateDockerfile: null,
        provider: claudeCodeProvider,
      });
      // Both binaries must be present for the early exit; missing rg
      // alone re-runs the apk/apt install line.
      expect(result.dockerfileBody).toContain(
        'command -v uvx >/dev/null 2>&1 && command -v rg >/dev/null 2>&1; then exit 0',
      );
    });
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

  describe('baseImageId invalidation', () => {
    it('produces different tags for the same dockerfile body when baseImageId differs', () => {
      const before = composeSandboxImage({
        envTemplateDockerfile: null,
        provider: claudeCodeProvider,
        baseImageId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      });
      const after = composeSandboxImage({
        envTemplateDockerfile: null,
        provider: claudeCodeProvider,
        baseImageId: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      });
      expect(before.tag).not.toBe(after.tag);
      expect(before.dockerfileBody).toBe(after.dockerfileBody);
    });

    it('falls back to body-only hash when baseImageId is null/omitted', () => {
      const omitted = composeSandboxImage({
        envTemplateDockerfile: null,
        provider: claudeCodeProvider,
      });
      const explicitNull = composeSandboxImage({
        envTemplateDockerfile: null,
        provider: claudeCodeProvider,
        baseImageId: null,
      });
      expect(omitted.tag).toBe(explicitNull.tag);
    });

    it('ignores baseImageId when env-template body does not reference the sandbox-core image', () => {
      const ubuntuTemplate = 'FROM ubuntu:24.04\nRUN apt-get install -y git\n';
      const a = composeSandboxImage({
        envTemplateDockerfile: ubuntuTemplate,
        provider: claudeCodeProvider,
        baseImageId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      });
      const b = composeSandboxImage({
        envTemplateDockerfile: ubuntuTemplate,
        provider: claudeCodeProvider,
        baseImageId: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      });
      expect(a.tag).toBe(b.tag);
    });

    it('honors baseImageId when env-template body references the sandbox-core image', () => {
      const piggybackTemplate = `FROM ${SANDBOX_CORE_IMAGE}\nRUN echo extra\n`;
      const before = composeSandboxImage({
        envTemplateDockerfile: piggybackTemplate,
        provider: claudeCodeProvider,
        baseImageId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      });
      const after = composeSandboxImage({
        envTemplateDockerfile: piggybackTemplate,
        provider: claudeCodeProvider,
        baseImageId: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      });
      expect(before.tag).not.toBe(after.tag);
    });

    it('does not embed the baseImageId into the rendered dockerfile body', () => {
      const result = composeSandboxImage({
        envTemplateDockerfile: null,
        provider: claudeCodeProvider,
        baseImageId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      });
      expect(result.dockerfileBody).not.toContain('sha256:aaaaaaaa');
    });
  });
});
