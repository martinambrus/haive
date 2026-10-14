import { describe, expect, it } from 'vitest';
import { taskTypeLabel } from './task-type-label';

describe('taskTypeLabel', () => {
  it('prefers the label the api sent', () => {
    expect(taskTypeLabel({ type: 'workflow', typeLabel: 'Feature delivery' })).toBe(
      'Feature delivery',
    );
  });

  it('falls back to the built-in label, plan_sequence and plan_merge included', () => {
    expect(taskTypeLabel({ type: 'workflow' })).toBe('Workflow');
    expect(taskTypeLabel({ type: 'plan_sequence', typeLabel: null })).toBe('Plan sequence');
    expect(taskTypeLabel({ type: 'plan_merge' })).toBe('Plan merge');
  });

  it('labels the task type draft conversation', () => {
    expect(taskTypeLabel({ type: 'type_draft' })).toBe('Task type draft');
  });

  it('shows the slug of a custom type with no label', () => {
    expect(taskTypeLabel({ type: 'acme_audit', typeLabel: null })).toBe('acme_audit');
  });
});
