import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { CLI_POLLABLE_JOB_OPTS, CLI_EXEC_JOB_NAMES, CONFIG_KEYS } from '@haive/shared';
import { expect, it, vi } from 'vitest';

it('removes snapshot-bearing jobs on either outcome while preserving ordinary retention', async () => {
  const source = ts.createSourceFile(
    'task-queue.ts',
    readFileSync(new URL('../src/queues/task-queue.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  let method: ts.MethodDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isMethodDeclaration(node) && node.name.getText(source) === 'enqueueCliInvocation')
      method = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(method).toBeDefined();
  const add = vi.fn();
  const js = ts.transpileModule(`({ ${method!.getText(source)} })`, {
    compilerOptions: { target: ts.ScriptTarget.ES2024 },
  }).outputText;
  const deps = runInNewContext(js, {
    getCliExecQueue: () => ({ add }),
    CLI_POLLABLE_JOB_OPTS,
    CLI_EXEC_JOB_NAMES,
    CONFIG_KEYS,
    configService: { getBoolean: async () => false },
  });
  await deps.enqueueCliInvocation({ spec: {} });
  expect(add.mock.calls[0]![2]).toMatchObject(CLI_POLLABLE_JOB_OPTS);
  await deps.enqueueCliInvocation({ spec: { planSnapshot: { nodes: [], edges: [] } } });
  expect(add.mock.calls[1]![2]).toMatchObject({ removeOnComplete: true, removeOnFail: true });
});
