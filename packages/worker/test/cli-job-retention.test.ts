import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { Queue, Worker, type JobsOptions } from 'bullmq';
import ts from 'typescript';
import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { CLI_POLLABLE_JOB_OPTS } from '@haive/shared';

const redisUrl = process.env.CLI_JOB_RETENTION_TEST_REDIS_URL;
// Opt-in only; never inherit the application's REDIS_URL.
describe.skipIf(!redisUrl)('cli-job retention against isolated Redis', () => {
  // Scan every production source file, following the queue receiver rather than the
  // job name: a dynamic name or a new producer file must obey the same policy.
  function scan(source: ts.SourceFile) {
    const found: { label: string; site: string; opts: JobsOptions }[] = [];
    function initializer(id: ts.Identifier): ts.Expression {
      for (let scope: ts.Node | undefined = id.parent; scope; scope = scope.parent) {
        if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
        for (const statement of scope.statements) {
          if (!ts.isVariableStatement(statement)) continue;
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name) && declaration.name.text === id.text) {
              if (!declaration.initializer) throw new Error(`No initializer for ${id.text}`);
              return declaration.initializer;
            }
          }
        }
      }
      throw new Error(`Unresolved options/queue identifier ${id.text} in ${source.fileName}`);
    }
    function isCliQueue(expression: ts.Expression): boolean {
      if (ts.isIdentifier(expression)) {
        try {
          return isCliQueue(initializer(expression));
        } catch {
          return false;
        }
      }
      return (
        (ts.isCallExpression(expression) &&
          expression.expression.getText(source) === 'getCliExecQueue') ||
        (ts.isNewExpression(expression) &&
          expression.arguments?.[0]?.getText(source) === 'QUEUE_NAMES.CLI_EXEC')
      );
    }
    function record(node: ts.CallExpression, name: ts.Expression, options?: ts.Expression) {
      const site = `${source.fileName} ${name.getText(source)}`;
      if (!options) throw new Error(`${site}: cli-exec add requires retention options`);
      const expression =
        ts.isIdentifier(options) && options.text !== 'CLI_POLLABLE_JOB_OPTS'
          ? initializer(options)
          : options;
      const js = ts.transpileModule(`(${expression.getText(source)})`, {
        compilerOptions: { target: ts.ScriptTarget.ES2024 },
      }).outputText;
      const opts = runInNewContext(js, { CLI_POLLABLE_JOB_OPTS }) as JobsOptions;
      for (const key of ['removeOnComplete', 'removeOnFail'] as const) {
        const retention = opts[key];
        if (
          retention !== true &&
          (!retention ||
            typeof retention !== 'object' ||
            retention.count !== undefined ||
            !('age' in retention) ||
            typeof retention.age !== 'number' ||
            retention.age < CLI_POLLABLE_JOB_OPTS[key].age)
        )
          throw new Error(`${site}: ${key} must remove only itself or retain by age without count`);
      }
      found.push({
        site,
        label: `${site}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
        opts,
      });
    }
    function visit(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        isCliQueue(node.expression.expression)
      ) {
        if (node.expression.name.text === 'add') {
          const [name, , options] = node.arguments;
          if (!name) throw new Error('cli-exec add has no name');
          record(node, name, options);
        } else if (node.expression.name.text === 'upsertJobScheduler') {
          const template = node.arguments[2];
          if (!template || !ts.isObjectLiteralExpression(template))
            throw new Error('Missing scheduler template');
          const property = (key: string) =>
            template.properties.find(
              (p): p is ts.PropertyAssignment =>
                ts.isPropertyAssignment(p) && p.name.getText(source) === key,
            )?.initializer;
          const name = property('name');
          if (!name) throw new Error('Missing scheduler job name');
          record(node, name, property('opts'));
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    return found;
  }

  function scanTree(path: string): ReturnType<typeof scan> {
    return readdirSync(new URL(`../../../${path}`, import.meta.url), {
      withFileTypes: true,
    }).flatMap((entry) => {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) return scanTree(child);
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return [];
      return scan(
        ts.createSourceFile(
          child,
          readFileSync(new URL(`../../../${child}`, import.meta.url), 'utf8'),
          ts.ScriptTarget.Latest,
          true,
        ),
      );
    });
  }
  const producers = redisUrl ? ['packages/worker/src', 'packages/api/src'].flatMap(scanTree) : [];

  it('discovers the complete set of cli-exec adds and scheduler templates', () => {
    expect(producers.map(({ site }) => site).sort()).toEqual(
      [
        'packages/api/src/lib/cli-version-refresh.ts CLI_EXEC_JOB_NAMES.REFRESH_VERSIONS',
        'packages/api/src/routes/cli-login-banner.ts CLI_EXEC_JOB_NAMES.LOGIN_CREATE',
        'packages/api/src/routes/cli-login-banner.ts CLI_EXEC_JOB_NAMES.PROBE',
        'packages/api/src/routes/cli-providers.ts CLI_EXEC_JOB_NAMES.BUILD_SANDBOX_IMAGE',
        'packages/api/src/routes/cli-providers.ts CLI_EXEC_JOB_NAMES.BUILD_SANDBOX_IMAGE',
        'packages/api/src/routes/cli-providers.ts CLI_EXEC_JOB_NAMES.PROBE',
        'packages/api/src/routes/cli-providers.ts CLI_EXEC_JOB_NAMES.PROVISION_OLLAMA_MODEL',
        'packages/api/src/routes/cli-providers.ts CLI_EXEC_JOB_NAMES.REMOVE_SANDBOX_IMAGE',
        'packages/api/src/routes/cli-providers.ts CLI_EXEC_JOB_NAMES.SIGN_OUT',
        'packages/worker/src/queues/cli-exec/handlers.ts CLI_EXEC_JOB_NAMES.REFRESH_VERSIONS',
        'packages/worker/src/queues/cli-exec/handlers.ts CLI_EXEC_JOB_NAMES.REFRESH_VERSIONS',
        'packages/worker/src/queues/task-queue.ts CLI_EXEC_JOB_NAMES.INVOKE',
      ].sort(),
    );
  });

  it('resolves method options locally, even when another function uses the same name', () => {
    const source = ts.createSourceFile(
      'scope-control.ts',
      `
      const deps = { async enqueue() {
        const queue = getCliExecQueue();
        const opts = { ...CLI_POLLABLE_JOB_OPTS };
        await queue.add(dynamicName, {}, opts);
      } };
      function unrelated() { const opts = { removeOnComplete: 1, removeOnFail: 1 }; }
    `,
      ts.ScriptTarget.Latest,
      true,
    );
    expect(scan(source).map(({ opts }) => opts)).toEqual([CLI_POLLABLE_JOB_OPTS]);
  });

  it.each(
    producers.flatMap((producer) =>
      ['completed', 'failed'].map((state) => ({ ...producer, state })),
    ),
  )(
    '$label preserves a young $state pollable result',
    async ({ opts, state }) => {
      const url = new URL(redisUrl!);
      const connection = {
        host: url.hostname,
        port: Number(url.port || 6379),
        db: Number(url.pathname.slice(1) || 0),
        username: url.username ? decodeURIComponent(url.username) : undefined,
        password: url.password ? decodeURIComponent(url.password) : undefined,
        ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
        maxRetriesPerRequest: null,
      };
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
