import { describe, expect, it } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { markProvidersReady } from '../src/queues/cli-exec/images.js';

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
