import { describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { getTableColumns } from 'drizzle-orm';
import { composedRequestedInputsHash } from '../src/lsp/composed-image-refs.js';
import {
  LSP_PROVIDER_IDENTITY_FIELDS,
  LSP_PROVIDER_IDENTITY_IGNORED_FIELDS,
} from '../src/lsp/composed-evidence.js';

describe('requested composed image input hash', () => {
  it.each(['body', 'name', 'cliVersion', 'extras'] as const)('binds %s', (field) => {
    const body = 'FROM ubuntu:24.04\n';
    const provider = {
      name: 'claude-code',
      cliVersion: '1.0.0',
      sandboxDockerfileExtra: null as string | null,
    };
    const deps = { lspServers: ['gopls'], lspServerVersions: { go: '0.18.0' } };
    const changedProvider = {
      ...provider,
      ...(field === 'name' ? { name: 'zai' } : {}),
      ...(field === 'cliVersion' ? { cliVersion: '2.0.0' } : {}),
      ...(field === 'extras' ? { sandboxDockerfileExtra: 'RUN echo changed' } : {}),
    };
    expect(
      composedRequestedInputsHash(
        field === 'body' ? `${body}RUN echo changed\n` : body,
        changedProvider,
        deps,
      ),
    ).not.toBe(composedRequestedInputsHash(body, provider, deps));
  });
});

it('classifies every provider schema column exactly once for LSP identity', () => {
  const fields = [...LSP_PROVIDER_IDENTITY_FIELDS, ...LSP_PROVIDER_IDENTITY_IGNORED_FIELDS];
  expect(new Set(fields).size).toBe(fields.length);
  expect([...fields].sort()).toEqual(Object.keys(getTableColumns(schema.cliProviders)).sort());
});
