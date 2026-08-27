import { describe, expect, it } from 'vitest';
import { planDeleteRefusal } from '../src/lib/plan-delete-refusal.js';

const task = (over: Partial<{ id: string; title: string; type: string }> = {}) => ({
  id: 't1',
  title: 'Plan chat: Mailer',
  type: 'plan_chat',
  ...over,
});

describe('planDeleteRefusal', () => {
  it('lets a correctly confirmed delete through', () => {
    expect(planDeleteRefusal({ confirm: 'redsys', repoName: 'redsys', openTasks: [] })).toBeNull();
  });

  it('refuses while a plan task can still write', () => {
    // A builder wave landing after the wipe would recreate a partial plan out
    // of nothing — worse than either outcome alone.
    const out = planDeleteRefusal({ confirm: 'redsys', repoName: 'redsys', openTasks: [task()] });
    expect(out?.status).toBe(409);
    expect(out?.code).toBe('plan_tasks_open');
    expect(out?.tasks).toHaveLength(1);
  });

  it('names every open task so the UI can link them', () => {
    const out = planDeleteRefusal({
      confirm: 'redsys',
      repoName: 'redsys',
      openTasks: [task(), task({ id: 't2', type: 'plan_build' })],
    });
    expect(out?.tasks?.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(out?.message).toContain('2 plan tasks');
  });

  it('reports the running task before the mistyped name', () => {
    // The task has to be dealt with either way; a name mismatch is noise until
    // it is.
    const out = planDeleteRefusal({ confirm: 'wrong', repoName: 'redsys', openTasks: [task()] });
    expect(out?.code).toBe('plan_tasks_open');
  });

  it('refuses a name that does not match', () => {
    const out = planDeleteRefusal({ confirm: 'redsy', repoName: 'redsys', openTasks: [] });
    expect(out?.status).toBe(400);
    expect(out?.code).toBe('plan_delete_confirm_mismatch');
  });

  it('refuses a case that does not match', () => {
    // The one place where "close enough" is the wrong answer.
    expect(
      planDeleteRefusal({ confirm: 'RedSys', repoName: 'redsys', openTasks: [] }),
    ).not.toBeNull();
  });

  it('forgives whitespace a copy-paste picked up', () => {
    expect(
      planDeleteRefusal({ confirm: '  redsys\n', repoName: 'redsys', openTasks: [] }),
    ).toBeNull();
  });

  it('refuses a missing or non-string confirmation', () => {
    // An empty repo name must not make an absent confirmation "match".
    for (const confirm of [undefined, null, '', 42, {}]) {
      expect(planDeleteRefusal({ confirm, repoName: 'redsys', openTasks: [] })).not.toBeNull();
    }
  });

  it('refuses when there is no name to confirm against', () => {
    // Otherwise the check is `'' === ''` and an absent confirmation passes —
    // the guard disappearing exactly where it is load-bearing.
    const out = planDeleteRefusal({ confirm: undefined, repoName: '   ', openTasks: [] });
    expect(out?.code).toBe('plan_delete_unconfirmable');
    expect(planDeleteRefusal({ confirm: '', repoName: '', openTasks: [] })).not.toBeNull();
  });
});
