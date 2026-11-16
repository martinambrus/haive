import { expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Database } from '@haive/database';
import { recheckInvocationToolchain } from '../src/queues/cli-exec/toolchain-audit.js';
import { sandboxToolchainBlock, withSandboxToolchain } from '../src/sandbox/toolchain-prompt.js';
import { fakeDockerRunner } from './fake-docker-runner.js';
const oldId = `sha256:${'a'.repeat(64)}`;
const newId = `sha256:${'b'.repeat(64)}`;
const prompt = withSandboxToolchain('\n\nCheck code\n', { imageId: oldId, php: 'absent' });
const block = sandboxToolchainBlock(prompt)!;
const spec = {
  command: 'cli',
  args: [prompt],
  env: {},
  sandboxToolchain: { imageId: oldId, block },
};
const runner = fakeDockerRunner({ inspect: async () => ({ exists: true, imageId: newId }) });

it('awaits a block-only, invocation-scoped audit update before returning the executable prompt', async () => {
  let release!: () => void;
  let stored = prompt;
  const where = vi.fn(async (condition: SQL) => {
    expect(new PgDialect().sqlToQuery(condition).params).toEqual(['run-id']);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const set = vi.fn((values: { prompt: SQL }) => {
    const query = new PgDialect().sqlToQuery(values.prompt);
    expect(query.sql).toContain('replace(');
    expect(query.params).toEqual([block + '\n\n']);
    stored = stored.replaceAll(query.params[0] as string, '');
    return { where };
  });
  const db = { update: () => ({ set }) } as unknown as Database;
  let returned = false;
  const work = recheckInvocationToolchain(spec, 'image:tag', 'run-id', runner, null, {}, db).then(
    (answer) => {
      returned = true;
      return answer;
    },
  );
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(where).toHaveBeenCalledTimes(1);
  expect(returned).toBe(false);
  release();
  const answer = await work;
  expect(answer.spec.args[0]).toBe(stored);
  expect(stored).toBe('\n\nCheck code\n');
});
it('refuses to send a changed prompt if the audit update fails', async () => {
  const db = {
    update: () => ({
      set: () => ({
        where: async () => {
          throw new Error('store down');
        },
      }),
    }),
  } as unknown as Database;
  await expect(
    recheckInvocationToolchain(spec, 'image:tag', 'run-id', runner, null, {}, db),
  ).rejects.toThrow('store down');
});
it('does no audit write for unchanged facts or invocations without a durable row', async () => {
  const update = vi.fn();
  const db = { update } as unknown as Database;
  const same = fakeDockerRunner({ inspect: async () => ({ exists: true, imageId: oldId }) });
  await recheckInvocationToolchain(spec, 'image:tag', 'run-id', same, null, {}, db);
  await recheckInvocationToolchain(spec, 'image:tag', null, runner, null, {}, db);
  expect(update).not.toHaveBeenCalled();
});
