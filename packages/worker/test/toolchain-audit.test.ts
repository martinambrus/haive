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

it('rejects a mismatched stamped offset before any invocation audit write', async () => {
  const update = vi.fn(() => ({ set: () => ({ where: async () => {} }) }));
  const db = { update } as unknown as Database;
  const payload = {
    ...spec,
    args: [`Moved prompt\n${prompt}`],
    sandboxToolchain: { imageId: oldId, block, offset: 0 },
  };
  await expect(
    recheckInvocationToolchain(payload, 'image:tag', 'run-id', runner, null, {}, db),
  ).rejects.toThrow('Sandbox toolchain advisory does not match its stamped prompt position');
  expect(update).not.toHaveBeenCalled();
});

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
    expect(query.sql).toContain('string_agg(');
    expect(query.sql).toContain('ordinal - 1 = any(');
    expect(query.sql).toContain('order by ordinal');
    expect(query.params).toEqual([[1], block + '\n\n', block + '\n\n']);
    stored = stored.replace(query.params[1] as string, () => '');
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

it('preserves a full quoted advisory in both CLI delivery and the invocation prompt', async () => {
  const body = `Task text quoting the advisory:\n${block}\n\nKeep this quote.`;
  const quoted = withSandboxToolchain(body, { imageId: oldId, php: 'absent' });
  let stored = quoted;
  const db = {
    update: () => ({
      set: (values: { prompt: SQL }) => {
        const query = new PgDialect().sqlToQuery(values.prompt);
        const separator = query.params[query.sql.includes('replace(') ? 0 : 1] as string;
        // Model the selected SQL operation at the storage seam.
        stored = query.sql.includes('replace(')
          ? stored.replaceAll(separator, '')
          : stored.replace(separator, () => '');
        return { where: async () => {} };
      },
    }),
  } as unknown as Database;
  const answer = await recheckInvocationToolchain(
    { ...spec, args: [quoted] },
    'image:tag',
    'run-id',
    runner,
    null,
    {},
    db,
  );
  expect(stored).toBe(body);
  expect(answer.spec.args[0]).toBe(body);
});

it.each([
  '',
  '<haive_agent_rules>\nKeep 💡 rules\n</haive_agent_rules>\n\n',
  `<haive_agent_rules>\nKeep 💡 rules and this quote:\n${block}\n\nEnd.\n</haive_agent_rules>\n\n`,
  `<haive_house_rules>\nKeep 💡 rules and this quote:\n${block}\n\nEnd.\n</haive_house_rules>\n\n`,
])(
  'preserves a full quote when the same positional stamp is audited twice (prefix %j)',
  async (prefix) => {
    const body = `Keep $& $$ and this full quote:\n${block}\n\nEnd.`;
    const queued = prefix + withSandboxToolchain(body, { imageId: oldId, php: 'absent' });
    const offset = [...prefix].length;
    const payload = {
      ...spec,
      args: [queued],
      sandboxToolchain: { imageId: oldId, block, offset },
    };
    let stored = queued;
    const db = {
      update: () => ({
        set: (values: { prompt: SQL }) => {
          const query = new PgDialect().sqlToQuery(values.prompt);
          expect(query.sql).toContain('when substr(');
          expect(query.sql).toContain('then overlay(');
          const separator = block + '\n\n';
          expect(query.params).toEqual([offset + 1, separator, separator, offset + 1, separator]);
          // Model PostgreSQL's character-based substring guard and overlay at the storage seam.
          const chars = [...stored];
          if (chars.slice(offset, offset + [...separator].length).join('') === separator)
            stored =
              chars.slice(0, offset).join('') +
              chars.slice(offset + [...separator].length).join('');
          return { where: async () => {} };
        },
      }),
    } as unknown as Database;
    for (let attempt = 0; attempt < 2; attempt++) {
      const answer = await recheckInvocationToolchain(
        payload,
        'image:tag',
        'run-id',
        runner,
        null,
        {},
        db,
      );
      expect(stored).toBe(prefix + body);
      expect(answer.spec.args[0]).toBe(prefix + body);
    }
  },
);

it('persists counted native removal without consuming quoted copies between prompts', async () => {
  const body = `Quoted:\n${block}\n\nKeep this.`;
  const segment = withSandboxToolchain(body, { imageId: oldId, php: 'absent' });
  const assembled = `${segment}\nNext agent:\n${segment}`;
  let stored = assembled;
  const db = {
    update: () => ({
      set: (values: { prompt: SQL }) => {
        const { params } = new PgDialect().sqlToQuery(values.prompt);
        const [ordinals, delimiter, separator] = params as [number[], string, string];
        expect(ordinals).toEqual([1, 3]);
        expect(delimiter).toBe(separator);
        stored = stored
          .split(separator)
          .map((piece, i) => (i === 0 || ordinals.includes(i) ? '' : delimiter) + piece)
          .join('');
        return { where: async () => {} };
      },
    }),
  } as unknown as Database;
  const answer = await recheckInvocationToolchain(
    {
      ...spec,
      args: [assembled],
      sandboxToolchain: { imageId: oldId, block, copies: 2, occurrences: [1, 3] },
    },
    'image:tag',
    'run-id',
    runner,
    null,
    {},
    db,
  );
  expect(stored).toBe(`${body}\nNext agent:\n${body}`);
  expect(answer.spec.args[0]).toBe(stored);
});
