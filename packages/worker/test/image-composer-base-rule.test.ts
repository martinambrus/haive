import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  composeSandboxImage,
  composedImageReferencesSandboxBase,
  SANDBOX_CORE_IMAGE,
  type ComposeInput,
} from '../src/sandbox/image-composer.js';

const realContext = process.env.SANDBOX_CORE_CONTEXT;
beforeAll(() => {
  process.env.SANDBOX_CORE_CONTEXT = fileURLToPath(
    new URL('./fixtures/git-mcp-context', import.meta.url),
  );
});
afterAll(() => {
  if (realContext === undefined) delete process.env.SANDBOX_CORE_CONTEXT;
  else process.env.SANDBOX_CORE_CONTEXT = realContext;
});

const legacyProvider = {
  name: 'claude-code' as const,
  cliVersion: '1.2.3',
  sandboxDockerfileExtra: null as string | null,
};
const namingProvider = {
  ...legacyProvider,
  sandboxDockerfileExtra: `RUN echo from ${SANDBOX_CORE_IMAGE}`,
};
const environmentImage = { ref: 'haive-env:abc123', imageId: 'sha256:envid1' };
const contract2 = {
  lspInstallContractVersion: 2,
  lspServers: ['php-extended'],
  lspServerVersions: { php: '1.18.4' },
};
const base = (extra: Partial<ComposeInput>): ComposeInput => ({
  envTemplateDockerfile: 'FROM node:22\nRUN echo hi\n',
  provider: legacyProvider,
  rtkVersion: '0.42.4',
  ...extra,
});

const shapes: [string, ComposeInput, boolean][] = [
  ['no environment template', base({ envTemplateDockerfile: null }), true],
  [
    'pasted body on the core image',
    base({ envTemplateDockerfile: `FROM ${SANDBOX_CORE_IMAGE}\n` }),
    true,
  ],
  ['pasted body on another image', base({ envTemplateDockerfile: 'FROM node:22\n' }), false],
  [
    'environment image replaces a core body',
    base({ envTemplateDockerfile: `FROM ${SANDBOX_CORE_IMAGE}\n`, environmentImage }),
    false,
  ],
  [
    'environment image with an extra naming the core',
    base({ environmentImage, provider: namingProvider }),
    true,
  ],
  ['contract 2 with an environment image', base({ ...contract2, environmentImage }), false],
  [
    'contract 2 with an environment image and an extra naming the core',
    base({ ...contract2, environmentImage, provider: namingProvider }),
    true,
  ],
  [
    'legacy contract 1 with an environment image',
    base({ lspInstallContractVersion: 1, environmentImage }),
    false,
  ],
];

describe('composedImageReferencesSandboxBase', () => {
  it.each(shapes)('%s', (_label, input, expected) => {
    const moves =
      composeSandboxImage({ ...input, baseImageId: 'sha256:a' }).tag !==
      composeSandboxImage({ ...input, baseImageId: 'sha256:b' }).tag;
    expect(composedImageReferencesSandboxBase(input)).toBe(expected);
    expect(moves).toBe(expected);
  });
});
