import { describe, expect, it } from 'vitest';
import type { PlanMessage } from '@/lib/api-client';
import { firstUnreadMessageId, opCount, startedLabel, stamp, taskProposal } from './plan-chat-turn';

function msg(id: string, role: PlanMessage['role']): PlanMessage {
  return {
    id,
    nodeId: 'n1',
    taskId: 't1',
    role,
    body: id,
    patch: null,
    cliLabel: null,
    createdAt: '2026-08-27T10:00:00.000Z',
  };
}

describe('opCount', () => {
  it('counts the operations a turn sent', () => {
    expect(opCount({ ops: [{ op: 'add' }, { op: 'update' }] })).toBe(2);
  });

  it('is zero for a turn that changed nothing', () => {
    // The case the badge exists for: the agent said it had split the node into
    // three children and sent an empty ops array.
    expect(opCount({ summary: 'Done — three children now hang off this node', ops: [] })).toBe(0);
  });

  it('has no count for a prose reply that carried no patch', () => {
    expect(opCount(null)).toBeNull();
    expect(opCount(undefined)).toBeNull();
  });

  it('refuses to read an unrecognised patch shape as "unchanged"', () => {
    // 0 renders as "plan unchanged", which would be a claim about a payload
    // this code did not understand.
    expect(opCount({ ops: 'three' })).toBeNull();
    expect(opCount({ patch: { ops: [] } })).toBeNull();
    expect(opCount('ops: []')).toBeNull();
    expect(opCount(42)).toBeNull();
  });
});

describe('stamp', () => {
  it('renders a real timestamp', () => {
    // Locale and zone are the viewer's, so assert it produced something with
    // the year in it rather than one particular rendering.
    expect(stamp('2026-08-27T10:00:00.000Z')).toContain('2026');
  });

  it('has no label rather than "Invalid Date"', () => {
    expect(stamp('not a date')).toBeNull();
    expect(stamp('')).toBeNull();
    expect(stamp(undefined)).toBeNull();
  });
});

describe('startedLabel', () => {
  it('names a conversation by when it started', () => {
    expect(startedLabel('2026-08-27T10:00:00.000Z')).toContain('2026');
  });

  it('still names a conversation whose first turn has no usable date', () => {
    expect(startedLabel(undefined)).toBe('Conversation');
    expect(startedLabel('not a date')).toBe('Conversation');
  });
});

describe('firstUnreadMessageId', () => {
  const transcript = [
    msg('u1', 'user'),
    msg('a1', 'assistant'),
    msg('u2', 'user'),
    msg('a2', 'assistant'),
    msg('a3', 'assistant'),
  ];

  it('has no divider when everything is read', () => {
    expect(firstUnreadMessageId(transcript, 0)).toBeNull();
  });

  it('puts one unread reply on the newest reply', () => {
    expect(firstUnreadMessageId(transcript, 1)).toBe('a3');
  });

  it('walks back over exactly as many replies as were unread', () => {
    expect(firstUnreadMessageId(transcript, 2)).toBe('a2');
    expect(firstUnreadMessageId(transcript, 3)).toBe('a1');
  });

  it('does not count the user’s own turns', () => {
    // Counting u2 would put the divider above a3 for a count of 2, hiding a
    // reply the user had not seen.
    expect(firstUnreadMessageId(transcript, 2)).not.toBe('u2');
  });

  it('marks the whole transcript new when the count outruns it', () => {
    expect(firstUnreadMessageId(transcript, 99)).toBe('a1');
  });

  it('has no divider when nothing has been said', () => {
    expect(firstUnreadMessageId([], 3)).toBeNull();
    expect(firstUnreadMessageId([msg('u1', 'user')], 3)).toBeNull();
  });

  it('ignores a negative count rather than pointing anywhere', () => {
    expect(firstUnreadMessageId(transcript, -1)).toBeNull();
  });
});

describe('taskProposal', () => {
  const good = {
    nodeRefs: ['a', 'b'],
    title: 'Comms plus the two on top',
    description: 'what to build',
    role: 'implements',
    reason: 'both wait on comms',
  };

  it('reads an offer out of a stored patch', () => {
    expect(taskProposal({ ops: [], taskProposal: good })).toEqual(good);
  });

  it('is null when the turn carried no offer', () => {
    expect(taskProposal({ ops: [] })).toBeNull();
    expect(taskProposal(null)).toBeNull();
    expect(taskProposal('a plain reply')).toBeNull();
  });

  it('refuses an offer the button could not act on', () => {
    // Each of these would render a button that leads somewhere useless, so the
    // transcript is better off showing the reply alone.
    expect(taskProposal({ taskProposal: { ...good, nodeRefs: [] } })).toBeNull();
    expect(taskProposal({ taskProposal: { ...good, title: '' } })).toBeNull();
    expect(taskProposal({ taskProposal: { ...good, role: 'green-them' } })).toBeNull();
    expect(taskProposal({ taskProposal: { ...good, nodeRefs: 'a,b' } })).toBeNull();
  });

  it('tolerates a missing reason rather than dropping the whole offer', () => {
    const { reason: _reason, ...noReason } = good;
    expect(taskProposal({ taskProposal: noReason })?.reason).toBe('');
  });
});
