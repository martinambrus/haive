import { describe, expect, it } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { markProvidersReady } from '../src/queues/cli-exec/images.js';
import { resolveImageTag } from '../src/sandbox/image-cache.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const TAG = 'haive-cli-claude:1.0.0';
const provider = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

describe('marking a shared tag ready', () => {
  it('leaves a sibling whose own build is still queued or running', async () => {
    const fake = createFakeDb({ cliProviders: schema.cliProviders });
    const rows: [number, string, string][] = [
      [1, TAG, 'building'],
      [2, TAG, 'building'],
      [3, TAG, 'failed'],
      [4, 'haive-cli-other:1.0.0', 'failed'],
    ];
    for (const [n, tag, status] of rows) {
      fake.insert(schema.cliProviders, {
        id: provider(n),
        userId: USER,
        name: 'claude-code',
        label: `p${n}`,
        sandboxImageTag: tag,
        sandboxImageBuildStatus: status,
      });
    }

    await markProvidersReady(fake.db as unknown as Database, TAG, provider(1), true);

    const status = new Map(
      fake.rows(schema.cliProviders).map((r) => [r.id, r.sandboxImageBuildStatus]),
    );
    expect(status.get(provider(1))).toBe('ready');
    expect(status.get(provider(2))).toBe('building');
    expect(status.get(provider(3))).toBe('ready');
    expect(status.get(provider(4))).toBe('failed');
  });
});

describe('marking a tag ready', () => {
  it('moves a sibling whose own build of the tag failed, and names what each row replaced', async () => {
    const fake = createFakeDb({ cliProviders: schema.cliProviders });
    const config = { name: 'claude-code' as const, cliVersion: '1.0.0' };
    const tag = resolveImageTag({
      ...config,
      providerId: provider(1),
      sandboxDockerfileExtra: null,
    })!;
    const rows: [number, string, string][] = [
      [1, 'haive-cli-claude:0.8.0', 'building'],
      [2, 'haive-cli-claude:0.9.0', 'failed'],
    ];
    for (const [n, older, status] of rows) {
      fake.insert(schema.cliProviders, {
        id: provider(n),
        userId: USER,
        ...config,
        label: `p${n}`,
        sandboxImageTag: older,
        sandboxImageBuildStatus: status,
      });
    }

    const replaced = await markProvidersReady(
      fake.db as unknown as Database,
      tag.tag,
      provider(1),
      tag.shared,
    );

    expect(
      fake.rows(schema.cliProviders).map((r) => [r.sandboxImageTag, r.sandboxImageBuildStatus]),
    ).toEqual([
      [tag.tag, 'ready'],
      [tag.tag, 'ready'],
    ]);
    expect([...replaced].sort()).toEqual(['haive-cli-claude:0.8.0', 'haive-cli-claude:0.9.0']);
  });
});
