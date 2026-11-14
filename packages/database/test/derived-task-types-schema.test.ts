import { getTableConfig } from 'drizzle-orm/pg-core';
import { expect, it } from 'vitest';
import { schema } from '../src/index.js';

it('appends the storage-only derived strategy without changing existing enum order', () => {
  expect(schema.runListStrategyEnum.enumValues).toEqual([
    'static',
    'workflow_paths',
    'run_app_modes',
    'derived',
  ]);
});

it('appends nullable definition columns with named checks and a restrictive self-FK', () => {
  const table = getTableConfig(schema.taskTypeDefinitions);
  expect(table.columns.slice(-3).map((column) => [column.name, column.notNull])).toEqual([
    ['prompt_steps', true],
    ['base_slug', false],
    ['changes', false],
  ]);
  expect(table.checks.map((constraint) => constraint.name)).toEqual([
    'task_type_definitions_derived_shape_check',
    'task_type_definitions_non_derived_shape_check',
    'task_type_definitions_base_not_self_check',
  ]);
  const fk = table.foreignKeys.find(
    (constraint) =>
      constraint.getName() === 'task_type_definitions_base_slug_task_type_definitions_slug_fk',
  );
  expect(fk?.onDelete).toBe('restrict');
  expect(fk?.reference().columns.map((column) => column.name)).toEqual(['base_slug']);
  expect(fk?.reference().foreignTable).toBe(schema.taskTypeDefinitions);
  expect(fk?.reference().foreignColumns.map((column) => column.name)).toEqual(['slug']);
  expect(table.columns.find((column) => column.name === 'slug')?.primary).toBe(true);
});

it('appends the nullable task plan after every existing task column', () => {
  const table = getTableConfig(schema.tasks);
  expect(table.columns.slice(-2).map((column) => [column.name, column.notNull])).toEqual([
    ['pr_remote_url', false],
    ['derived_run_plan', false],
  ]);
});
