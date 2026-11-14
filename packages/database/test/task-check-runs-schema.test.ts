import { getTableConfig } from 'drizzle-orm/pg-core';
import { expect, it } from 'vitest';
import { schema } from '../src/index.js';

it('keeps check history without repository text, with attempt uniqueness and safe deletion', () => {
  const c = getTableConfig(schema.taskCheckRuns);
  expect(c.columns.map((v) => v.name)).toEqual([
    'id',
    'task_id',
    'task_step_id',
    'step_id',
    'slot',
    'attempt_id',
    'outcome',
    'started_at',
    'ended_at',
  ]);
  expect(c.checks.map((v) => v.name)).toEqual([
    'task_check_runs_slot_check',
    'task_check_runs_outcome_check',
  ]);
  expect(c.uniqueConstraints[0]?.columns.map((v) => v.name)).toEqual([
    'task_id',
    'step_id',
    'slot',
    'attempt_id',
  ]);
  expect(c.indexes[0]?.config.columns.map((v) => 'name' in v && v.name)).toEqual(['task_id']);
  expect(c.foreignKeys.map((v) => v.onDelete)).toEqual(['cascade', 'set null']);
});

it('keeps recording coverage independently of task deletion', () => {
  const c = getTableConfig(schema.taskCheckRecording);
  expect(c.columns.map((v) => v.name)).toEqual(['id', 'started_at']);
  expect(c.foreignKeys).toHaveLength(0);
});
