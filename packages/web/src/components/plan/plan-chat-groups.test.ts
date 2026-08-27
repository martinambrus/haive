import { describe, expect, it } from 'vitest';
import { groupPlanConversations, liveConversation } from './plan-chat-groups';
import type { PlanConversation, PlanMessage } from '@/lib/api-client';

const msg = (id: string, taskId: string | null, role: 'user' | 'assistant'): PlanMessage => ({
  id,
  nodeId: 'n1',
  taskId,
  role,
  body: id,
  patch: null,
  createdAt: '2026-01-01T00:00:00.000Z',
});

const conv = (taskId: string, status: PlanConversation['status']): PlanConversation => ({
  taskId,
  status,
  completedAt: null,
});

describe('groupPlanConversations', () => {
  it('has nothing to group when the node has never been chatted about', () => {
    expect(groupPlanConversations([], [])).toEqual([]);
  });

  it('keeps each task’s turns together, oldest conversation first', () => {
    const groups = groupPlanConversations(
      [msg('a1', 't1', 'user'), msg('a2', 't1', 'assistant'), msg('b1', 't2', 'user')],
      [conv('t1', 'completed'), conv('t2', 'waiting_user')],
    );
    expect(groups.map((g) => g.taskId)).toEqual(['t1', 't2']);
    expect(groups[0]?.messages.map((m) => m.id)).toEqual(['a1', 'a2']);
  });

  it('reunites a task’s turns even if another task wrote in between', () => {
    // Two chats open on one node interleave in time but are separate exchanges.
    const groups = groupPlanConversations(
      [msg('a1', 't1', 'user'), msg('b1', 't2', 'user'), msg('a2', 't1', 'assistant')],
      [conv('t1', 'running'), conv('t2', 'running')],
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]?.messages.map((m) => m.id)).toEqual(['a1', 'a2']);
  });

  it('marks cancelled, failed and completed conversations ended', () => {
    for (const status of ['cancelled', 'failed', 'completed'] as const) {
      const [group] = groupPlanConversations([msg('m', 't', 'user')], [conv('t', status)]);
      expect(group?.ended).toBe(true);
    }
  });

  it('leaves a running or parked conversation open', () => {
    for (const status of ['running', 'queued', 'waiting_user'] as const) {
      const [group] = groupPlanConversations([msg('m', 't', 'user')], [conv('t', status)]);
      expect(group?.ended).toBe(false);
    }
  });

  it('treats a task the server did not describe as ended', () => {
    // Offering to continue a conversation that cannot take a turn is worse than
    // starting a new one.
    const [group] = groupPlanConversations([msg('m', 'gone', 'user')], []);
    expect(group?.ended).toBe(true);
  });

  it('gives an orphaned turn its own ended group', () => {
    // taskId is `on delete set null`, so these are real.
    const groups = groupPlanConversations(
      [msg('old', null, 'user'), msg('new', 't', 'user')],
      [conv('t', 'running')],
    );
    expect(groups.map((g) => g.taskId)).toEqual([null, 't']);
    expect(groups[0]?.ended).toBe(true);
  });
});

describe('liveConversation', () => {
  it('is the newest conversation still able to take a turn', () => {
    const groups = groupPlanConversations(
      [msg('a', 't1', 'user'), msg('b', 't2', 'user')],
      [conv('t1', 'running'), conv('t2', 'running')],
    );
    expect(liveConversation(groups)?.taskId).toBe('t2');
  });

  it('skips ended conversations to find an older live one', () => {
    const groups = groupPlanConversations(
      [msg('a', 't1', 'user'), msg('b', 't2', 'user')],
      [conv('t1', 'running'), conv('t2', 'cancelled')],
    );
    expect(liveConversation(groups)?.taskId).toBe('t1');
  });

  it('is null when everything has ended, so the next message starts fresh', () => {
    const groups = groupPlanConversations([msg('a', 't1', 'user')], [conv('t1', 'cancelled')]);
    expect(liveConversation(groups)).toBeNull();
  });
});
