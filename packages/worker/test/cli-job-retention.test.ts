import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { Queue, Worker, type JobsOptions } from 'bullmq';
import ts from 'typescript';
import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { CLI_POLLABLE_JOB_OPTS } from '@haive/shared';

// Read the actual producers' options, without booting the application or its DB.
// Running those options through BullMQ matters: count retention trims the WHOLE
// queue's finished set, including jobs enqueued with a different retention policy.
const producers = [
  'packages/worker/src/queues/task-queue.ts',
  'packages/api/src/routes/cli-providers.ts',
  'packages/api/src/routes/cli-login-banner.ts',
  'packages/api/src/lib/cli-version-refresh.ts',
  'packages/worker/src/queues/cli-exec/handlers.ts',
].flatMap((path) => {
  const source = ts.createSourceFile(
    path,
    readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: { label: string; opts: JobsOptions }[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'add'
    ) {
      const [name, , options] = node.arguments;
      if (name && options && name.getText(source).startsWith('CLI_EXEC_JOB_NAMES.')) {
        let expression = options;
        if (ts.isIdentifier(options)) {
          let scope: ts.Node = node;
          while (scope.parent && !ts.isArrowFunction(scope)) scope = scope.parent;
          let initializer: ts.Expression | undefined;
          const find = (child: ts.Node) => {
            if (ts.isVariableDeclaration(child) && child.name.getText(source) === options.text)
              initializer = child.initializer;
            ts.forEachChild(child, find);
          };
          find(scope);
          if (initializer) expression = initializer;
        }
        const js = ts.transpileModule(`(${expression.getText(source)})`, {
          compilerOptions: { target: ts.ScriptTarget.ES2024 },
        }).outputText;
        const opts = runInNewContext(js, { CLI_POLLABLE_JOB_OPTS }) as JobsOptions;
        found.push({
          label: `${path}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${name.getText(source)}`,
          opts,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
});

const redisUrl = process.env.CLI_JOB_RETENTION_REDIS_URL;
// Opt-in only; never inherit the application's REDIS_URL.
describe.skipIf(!redisUrl)('cli-job retention against isolated Redis', () => {
  it.each(
    producers.flatMap((producer) =>
      ['completed', 'failed'].map((state) => ({ ...producer, state })),
    ),
  )(
    '$label preserves a young $state pollable result',
    async ({ opts, state }) => {
      expect(redisUrl).toBe('redis://127.0.0.1:44935');
      const connection = { host: '127.0.0.1', port: 44935, maxRetriesPerRequest: null };
      const name = `t420-retention-${randomUUID()}`;
      const redis = new Redis(connection);
      const queue = new Queue(name, { connection });
      const worker = new Worker(
        name,
        async () => {
          if (state === 'failed') throw new Error('controlled failure');
          return { ok: true };
        },
        { connection, autorun: false },
      );
      try {
        const pollable = await queue.add('pollable', {}, CLI_POLLABLE_JOB_OPTS);
        let job = await worker.getNextJob('control');
        expect(job?.id).toBe(pollable.id);
        if (state === 'completed') await job!.moveToCompleted({ ok: true }, 'control', false);
        else await job!.moveToFailed(new Error('controlled failure'), 'control', false);

        // 101 completions/failures exceed both old caps (100 INVOKE / 50 build).
        for (let i = 0; i < 101; i++) {
          await queue.add('other', {}, opts);
          job = await worker.getNextJob('burst');
          expect(job).toBeDefined();
          if (state === 'completed') await job!.moveToCompleted({ ok: true }, 'burst', false);
          else {
            job!.attemptsMade = Math.max(0, (job!.opts.attempts ?? 1) - 1);
            await job!.moveToFailed(new Error('burst failure'), 'burst', false);
          }
        }
        expect(
          await queue.getJob(pollable.id!),
          'a fresh polled record must survive other job completions',
        ).toBeDefined();
        expect(await pollable.getState()).toBe(state);
        console.info(
          `${name}: ${state} result survived 101 other jobs; opts=${JSON.stringify(opts)}`,
        );

        const retention = state === 'completed' ? opts.removeOnComplete : opts.removeOnFail;
        if (retention === true) {
          // Login/probe/build successes still discard their own results immediately.
          expect(await queue.getJob(job!.id!)).toBeUndefined();
        } else {
          // Advance finished timestamps only inside this queue; never change Redis's
          // clock. An age-retaining producer must also prune expired records.
          expect(typeof retention).toBe('object');
          const age = (retention as { age: number }).age;
          expect(age).toBeGreaterThanOrEqual(CLI_POLLABLE_JOB_OPTS.removeOnComplete.age);
          const old = Date.now() - (age + 1) * 1000;
          const finishedKey = `bull:${name}:${state}`;
          const ids = await redis.zrange(finishedKey, '0', '-1');
          const batch = redis.pipeline();
          for (const id of ids) {
            batch.zadd(finishedKey, old, id);
            batch.hset(`bull:${name}:${id}`, 'finishedOn', String(old));
          }
          await batch.exec();
          await queue.add('prune', {}, opts);
          job = await worker.getNextJob('prune');
          if (state === 'completed') await job!.moveToCompleted({ ok: true }, 'prune', false);
          else {
            job!.attemptsMade = Math.max(0, (job!.opts.attempts ?? 1) - 1);
            await job!.moveToFailed(new Error('prune failure'), 'prune', false);
          }
          expect(await queue.getJob(pollable.id!)).toBeUndefined();
          expect(await redis.zcard(finishedKey)).toBe(1);
          console.info(`${name}: old ${state} records pruned after ${age}s`);
        }
      } finally {
        await worker.close();
        try {
          await queue.obliterate({ force: true });
          expect(await redis.keys(`bull:${name}:*`), 'all test keys removed').toEqual([]);
        } finally {
          await queue.close();
          await redis.quit();
        }
        console.info(`${name}: cleanup complete`);
      }
    },
    20_000,
  );
});
