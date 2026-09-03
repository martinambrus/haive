import { describe, it, expect } from 'vitest';
import { MAX_PROPOSED_OPS, describePlanOp, proposedOps } from './11f-plan-reconcile.js';

const KNOWN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const titles = new Map([[KNOWN, 'Auth service']]);

describe('describePlanOp', () => {
  it('calls an upsert on an unknown ref what it is — a new node', () => {
    expect(
      describePlanOp(
        { op: 'upsert', nodeRef: 'tmp-x', parentRef: KNOWN, title: 'Rate limiter' },
        titles,
      ),
    ).toBe('Add node "Rate limiter" under "Auth service"');
  });

  it('names what an update actually changes', () => {
    expect(describePlanOp({ op: 'upsert', nodeRef: KNOWN, status: 'done' }, titles)).toBe(
      'Update "Auth service": mark done',
    );
    expect(
      describePlanOp(
        {
          op: 'upsert',
          nodeRef: KNOWN,
          codeLinks: [{ repoPath: 'src/a.ts' }, { repoPath: 'src/b.ts' }],
        },
        titles,
      ),
    ).toBe('Update "Auth service": link src/a.ts, src/b.ts');
  });

  it('says so when an update changes nothing visible', () => {
    // Better than a tick box with an empty label next to it.
    expect(describePlanOp({ op: 'upsert', nodeRef: KNOWN }, titles)).toContain('no visible change');
  });

  it('describes links, unlinks and deletes', () => {
    expect(
      describePlanOp({ op: 'link', fromRef: KNOWN, toRef: KNOWN, kind: 'depends_on' }, titles),
    ).toContain('depends_on');
    expect(
      describePlanOp({ op: 'unlink', fromRef: KNOWN, toRef: KNOWN, kind: 'affects' }, titles),
    ).toContain('Remove the affects link');
    expect(describePlanOp({ op: 'delete', nodeRef: KNOWN }, titles)).toBe(
      'Delete "Auth service" and everything under it',
    );
  });

  it('never renders an empty label for an op it cannot read', () => {
    // The label is the only thing between the developer and approving something
    // they did not understand.
    const line = describePlanOp({ op: 'teleport', nodeRef: KNOWN }, titles);
    expect(line).toContain('Unrecognised change');
    expect(line).toContain('leave this unticked');
    expect(describePlanOp({}, titles)).toContain('Unrecognised change');
  });

  it('shortens an id it has no title for rather than printing 36 characters', () => {
    expect(
      describePlanOp({ op: 'delete', nodeRef: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, titles),
    ).toBe('Delete "bbbbbbbb…" and everything under it');
  });
});

describe('proposedOps', () => {
  it('reads the ops out of an agent reply', () => {
    expect(proposedOps({ summary: 's', ops: [{ op: 'delete', nodeRef: KNOWN }] })).toHaveLength(1);
  });

  it('returns nothing for a reply that is not a patch', () => {
    expect(proposedOps('I had a look and everything seems fine')).toEqual([]);
    expect(proposedOps(null)).toEqual([]);
  });

  it('treats an empty proposal as the normal outcome, not an error', () => {
    // A task that implemented an existing node should propose nothing.
    expect(proposedOps({ summary: 'nothing to change', ops: [] })).toEqual([]);
  });

  it('caps the proposal at a reviewable size', () => {
    const many = Array.from({ length: MAX_PROPOSED_OPS + 25 }, () => ({
      op: 'delete',
      nodeRef: KNOWN,
    }));
    expect(proposedOps({ ops: many })).toHaveLength(MAX_PROPOSED_OPS);
  });
});
