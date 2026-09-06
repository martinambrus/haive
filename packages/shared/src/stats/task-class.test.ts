import { describe, expect, it } from 'vitest';
import {
  knownTaskTypes,
  isTaskClass,
  resolveTaskClass,
  TASK_CLASSES,
  typesForClass,
} from './task-class.js';

describe('resolveTaskClass', () => {
  it('maps each enum member to its kind', () => {
    const expected: Record<string, string> = {
      workflow: 'work',
      plan_build: 'plan',
      plan_chat: 'plan',
      plan_sequence: 'plan',
      plan_merge: 'plan',
      advisory: 'plan',
      onboarding: 'setup',
      onboarding_upgrade: 'setup',
      kb_author: 'setup',
      env_replicate: 'setup',
      run_app: 'run',
    };
    for (const [type, taskClass] of Object.entries(expected)) {
      expect(resolveTaskClass({ type }).taskClass).toBe(taskClass);
    }
  });

  it('classifies advisory as plan work despite carrying no plan_ prefix', () => {
    // A prefix test would miss this one and absorb any future plan_* that is not plan work.
    expect(resolveTaskClass({ type: 'advisory' }).taskClass).toBe('plan');
  });

  it('separates a rollback from an upgrade by metadata, not by type', () => {
    // Rollback is not an enum member: it is onboarding_upgrade + metadata.mode.
    const rollback = resolveTaskClass({
      type: 'onboarding_upgrade',
      metadata: { mode: 'rollback', rolledBackFromTaskId: 'x' },
    });
    expect(rollback).toMatchObject({ taskClass: 'setup', isRollback: true, subClass: 'rollback' });

    const upgrade = resolveTaskClass({ type: 'onboarding_upgrade', metadata: {} });
    expect(upgrade).toMatchObject({ taskClass: 'setup', isRollback: false, subClass: 'upgrade' });

    // Absent metadata is an upgrade, not an unknown.
    expect(resolveTaskClass({ type: 'onboarding_upgrade' }).subClass).toBe('upgrade');
    expect(resolveTaskClass({ type: 'onboarding_upgrade', metadata: null }).isRollback).toBe(false);
  });

  it('never marks a non-upgrade task as a rollback', () => {
    // metadata.mode is only meaningful on onboarding_upgrade; another type could carry an
    // unrelated `mode` key.
    const r = resolveTaskClass({ type: 'workflow', metadata: { mode: 'rollback' } });
    expect(r.isRollback).toBe(false);
    expect(r.taskClass).toBe('work');
  });

  it('carries the execution path as the sub-class for Work only', () => {
    expect(resolveTaskClass({ type: 'workflow', executionPath: 'quick_bugfix' }).subClass).toBe(
      'quick_bugfix',
    );
    expect(resolveTaskClass({ type: 'workflow', executionPath: null }).subClass).toBeNull();
    // A plan task may carry one on the row; it is not a meaningful subdivision there.
    expect(
      resolveTaskClass({ type: 'plan_build', executionPath: 'full_workflow' }).subClass,
    ).toBeNull();
  });

  it('resolves an unrecognised type to other rather than guessing', () => {
    // A new task type is likelier than a corrupt row. Folding it into work would inflate
    // delivery; folding it into setup would inflate overhead. Both silently.
    for (const type of ['some_future_type', '', 'WORKFLOW']) {
      expect(resolveTaskClass({ type }).taskClass).toBe('other');
    }
    expect(resolveTaskClass({ type: null }).taskClass).toBe('other');
    expect(resolveTaskClass({ type: undefined }).taskClass).toBe('other');
  });

  it('never throws on a malformed row', () => {
    expect(() => resolveTaskClass({ type: null, metadata: null })).not.toThrow();
  });
});

describe('typesForClass', () => {
  it('lists the enum members of a class so the filter can be pushed into SQL', () => {
    expect(typesForClass('run')).toEqual(['run_app']);
    expect(typesForClass('plan')!.sort()).toEqual(
      ['advisory', 'plan_build', 'plan_chat', 'plan_merge', 'plan_sequence'].sort(),
    );
  });

  it('returns null for other, which has no member list by construction', () => {
    // `other` is defined negatively — whatever the table does not name — so the caller has to
    // express it as NOT IN (knownTaskTypes()).
    expect(typesForClass('other')).toBeNull();
  });

  it('partitions every known type exactly once', () => {
    const listed = TASK_CLASSES.flatMap((c) => typesForClass(c) ?? []);
    expect(listed.slice().sort()).toEqual(knownTaskTypes().slice().sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('agrees with resolveTaskClass for every known type', () => {
    // The two must not drift: one drives SQL filtering, the other drives per-row labelling.
    for (const type of knownTaskTypes()) {
      const cls = resolveTaskClass({ type }).taskClass;
      expect(typesForClass(cls)).toContain(type);
    }
  });
});

describe('isTaskClass', () => {
  it('accepts only the five classes', () => {
    for (const c of TASK_CLASSES) expect(isTaskClass(c)).toBe(true);
    for (const bad of ['workflow', '', null, undefined, 7, 'Work'])
      expect(isTaskClass(bad)).toBe(false);
  });
});
