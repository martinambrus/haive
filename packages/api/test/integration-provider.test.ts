import { describe, expect, it } from 'vitest';
import { CORE_FORGE_PROVIDER_SPECS } from '@haive/shared/forge';
import type { IntegrationProviderSpec } from '@haive/shared/modularity';
import { writeAccessOf } from '../src/lib/integration-provider.js';

const READ_FILE = {
  opId: 'read_file',
  description: 'Read',
  inputSchema: {},
  access: 'read',
} as const;
const WRITE_FILE = {
  opId: 'write_file',
  description: 'Write',
  inputSchema: {},
  access: 'write',
} as const;

const spec = (over: Partial<IntegrationProviderSpec> = {}): IntegrationProviderSpec => ({
  id: 'module.stub.vendor',
  displayName: 'Stub',
  categories: ['file-storage'],
  selfHosted: false,
  auth: [
    {
      kind: 'device',
      deviceCodeUrl: 'https://stub.example.test/device/code',
      tokenUrl: 'https://stub.example.test/oauth/token',
      scopes: { read: ['files.read'], write: ['files.write'] },
    },
  ],
  operations: [READ_FILE],
  ...over,
});

describe('writeAccessOf', () => {
  it('names the write scopes of each web or device sign-in and none for a token method', () => {
    const github = CORE_FORGE_PROVIDER_SPECS.find((s) => s.id === 'github')!;
    const gitea = CORE_FORGE_PROVIDER_SPECS.find((s) => s.id === 'gitea')!;

    expect(writeAccessOf(github).writeScopes).toEqual({ oauth2: ['repo'], device: ['repo'] });
    expect(writeAccessOf(gitea).writeScopes).toEqual({});
    expect(writeAccessOf(spec()).writeScopes).toEqual({ device: ['files.write'] });
  });

  it('can write when the provider declares a write operation', () => {
    const github = CORE_FORGE_PROVIDER_SPECS.find((s) => s.id === 'github')!;

    expect(writeAccessOf(github).canWrite).toBe(true);
    expect(writeAccessOf(spec({ operations: [READ_FILE, WRITE_FILE] })).canWrite).toBe(true);
  });

  it('cannot write when every operation only reads', () => {
    expect(writeAccessOf(spec({ operations: [READ_FILE] })).canWrite).toBe(false);
    expect(writeAccessOf(spec({ operations: undefined })).canWrite).toBe(false);
  });

  it('may write when the provider is an MCP surface, whose tools declare no access', () => {
    const mcp = spec({ operations: undefined, mcp: { kind: 'remote', url: 'https://mcp.test/' } });

    expect(writeAccessOf(mcp).canWrite).toBe(true);
  });
});
