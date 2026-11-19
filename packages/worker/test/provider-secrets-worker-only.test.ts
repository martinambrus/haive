import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { envelopeEncrypt } from '@haive/shared';
import { CLAUDE_USAGE_OAUTH_SECRET } from '@haive/shared/claude-oauth';

vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  secretsService: { getMasterKek: async () => 'ab'.repeat(32) },
}));

import { resolveProviderSecrets } from '../src/secrets/provider-secrets.js';
import { readProviderSecretToken } from '../src/usage-window/token-source.js';

const KEK = 'ab'.repeat(32);
const PROVIDER = 'provider-a';
const OTHER_PROVIDER = 'provider-b';
const secret = () => randomBytes(16).toString('hex');
const TOKEN = secret();
const GRANT = secret();
const AUTH = secret();

/** Every value a drizzle condition binds, flattened. */
function conditionValues(node: unknown, acc: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const n of node) conditionValues(n, acc);
    return acc;
  }
  const obj = node as Record<string, unknown>;
  if ('value' in obj && 'encoder' in obj) acc.push(obj.value);
  const chunks = obj.queryChunks;
  if (Array.isArray(chunks)) for (const c of chunks) conditionValues(c, acc);
  return acc;
}

const rows = [
  { providerId: PROVIDER, secretName: 'CLAUDE_CODE_OAUTH_TOKEN', ...envelopeEncrypt(TOKEN, KEK) },
  { providerId: PROVIDER, secretName: CLAUDE_USAGE_OAUTH_SECRET, ...envelopeEncrypt(GRANT, KEK) },
  { providerId: PROVIDER, secretName: 'ANTHROPIC_AUTH_TOKEN', ...envelopeEncrypt(AUTH, KEK) },
];

let db: Database;
beforeEach(() => {
  const matching = (where: unknown) => {
    const values = conditionValues(where);
    return rows.filter((r) => values.every((v) => v === r.providerId || v === r.secretName));
  };
  db = {
    query: {
      cliProviderSecrets: {
        findMany: async (opts: { where: unknown }) => matching(opts.where),
        findFirst: async (opts: { where: unknown }) => matching(opts.where)[0],
      },
    },
  } as unknown as Database;
});

describe('worker-only provider secrets', () => {
  it('leaves the usage grant out of the env-builder resolver and keeps the other secrets', async () => {
    const resolved = await resolveProviderSecrets(db, PROVIDER);
    expect(Object.keys(resolved).includes(CLAUDE_USAGE_OAUTH_SECRET)).toBe(false);
    expect(Object.values(resolved).includes(GRANT)).toBe(false);
    expect(resolved.CLAUDE_CODE_OAUTH_TOKEN === TOKEN).toBe(true);
    expect(resolved.ANTHROPIC_AUTH_TOKEN === AUTH).toBe(true);
  });

  it('still reads the grant and every other secret by name for the poller', async () => {
    expect((await readProviderSecretToken(db, PROVIDER, CLAUDE_USAGE_OAUTH_SECRET)) === GRANT).toBe(
      true,
    );
    expect((await readProviderSecretToken(db, PROVIDER, 'CLAUDE_CODE_OAUTH_TOKEN')) === TOKEN).toBe(
      true,
    );
    expect((await readProviderSecretToken(db, PROVIDER, 'ANTHROPIC_AUTH_TOKEN')) === AUTH).toBe(
      true,
    );
  });

  it('returns null for an absent name and for another provider', async () => {
    expect((await readProviderSecretToken(db, PROVIDER, 'NOT_STORED')) === null).toBe(true);
    expect(
      (await readProviderSecretToken(db, OTHER_PROVIDER, CLAUDE_USAGE_OAUTH_SECRET)) === null,
    ).toBe(true);
    expect(
      (await readProviderSecretToken(db, OTHER_PROVIDER, 'CLAUDE_CODE_OAUTH_TOKEN')) === null,
    ).toBe(true);
  });
});
