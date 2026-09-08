import { describe, it, expect } from 'vitest';
import { planReconcileStep, type PlanReconcileDetect } from './11f-plan-reconcile.js';
import { MAX_PROPOSED_OPS, describePlanOp, proposedOps } from './_plan-ops.js';

const KNOWN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const titles = new Map([[KNOWN, 'Auth service']]);

describe('describePlanOp', () => {
  it('calls an upsert on an unknown ref what it is — a new node', () => {
    expect(
      describePlanOp(
        { op: 'upsert', nodeRef: 'tmp-x', parentRef: KNOWN, title: 'Rate limiter' },
        titles,
      ),
    ).toBe('Add node **`Rate limiter`** under **`Auth service`**');
  });

  it('names what an update actually changes', () => {
    expect(describePlanOp({ op: 'upsert', nodeRef: KNOWN, status: 'done' }, titles)).toBe(
      'Update **`Auth service`**: mark done',
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
    ).toBe('Update **`Auth service`**: link `src/a.ts`, `src/b.ts`');
  });

  it('says which links are TESTS, because that is a different claim to approve', () => {
    expect(
      describePlanOp(
        {
          op: 'upsert',
          nodeRef: KNOWN,
          codeLinks: [{ repoPath: 'src/a.ts' }, { repoPath: 'tests/a.spec.ts', role: 'covers' }],
        },
        titles,
      ),
    ).toBe('Update **`Auth service`**: link `src/a.ts`; link tests `tests/a.spec.ts`');
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
      'Delete **`Auth service`** and everything under it',
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

  it('reads create-vs-update off the ref shape, not off the title map', () => {
    // The map is a display resource and can be short of a ref. Deciding on it
    // turned every status / code-link update into `Add node "untitled" under a
    // node` — a label describing the opposite of what applying the op does.
    const none = new Map<string, string>();
    expect(describePlanOp({ op: 'upsert', nodeRef: KNOWN, status: 'done' }, none)).toBe(
      'Update **`aaaaaaaa…`**: mark done',
    );
    expect(
      describePlanOp(
        { op: 'upsert', nodeRef: 'tmp-x', parentRef: KNOWN, title: 'Rate limiter' },
        none,
      ),
    ).toBe('Add node **`Rate limiter`** under **`aaaaaaaa…`**');
  });

  it('fences a title that contains a backtick instead of spilling markdown', () => {
    // Titles are written by people and agents. A one-backtick span around one
    // ends early, and the rest of the label renders as markdown in the form.
    const withTick = new Map([[KNOWN, 'The `data` blob']]);
    expect(describePlanOp({ op: 'delete', nodeRef: KNOWN }, withTick)).toBe(
      'Delete **``The `data` blob``** and everything under it',
    );
  });

  it('reads a ref the agent quoted as `node:<uuid>`', () => {
    // The patch contract tells the agent to copy ids in that form and
    // parsePlanPatch normalises nothing, so the raw op carries the prefix —
    // apply strips it and updates, and the label has to say the same.
    expect(describePlanOp({ op: 'upsert', nodeRef: `node:${KNOWN}`, status: 'done' }, titles)).toBe(
      'Update **`Auth service`**: mark done',
    );
    expect(
      describePlanOp(
        { op: 'upsert', nodeRef: 'node:api', parentRef: `node:${KNOWN}`, title: 'Rate limiter' },
        titles,
      ),
    ).toBe('Add node **`Rate limiter`** under **`Auth service`**');
  });

  it('shortens an id it has no title for rather than printing 36 characters', () => {
    expect(
      describePlanOp({ op: 'delete', nodeRef: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, titles),
    ).toBe('Delete **`bbbbbbbb…`** and everything under it');
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

describe('the reconcile form', () => {
  const detected = (over: Partial<PlanReconcileDetect> = {}): PlanReconcileDetect => ({
    repositoryId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    planMarkdown: '',
    spec: '',
    changedPaths: ['src/a.ts'],
    affected: [],
    nodeCount: 1,
    nodeTitles: { [KNOWN]: 'Auth service' },
    ...over,
  });

  const labels = (d: PlanReconcileDetect, ops: unknown[]): string[] =>
    (
      planReconcileStep.form!(null as never, d, { ops })?.fields[0] as {
        options: { label: string }[];
      }
    ).options.map((o) => o.label);

  it('names the nodes an op touches, from the titles the detect payload carries', () => {
    expect(
      labels(detected(), [
        { op: 'upsert', nodeRef: KNOWN, status: 'done' },
        { op: 'upsert', nodeRef: 'tmp-x', parentRef: KNOWN, title: 'Rate limiter' },
      ]),
    ).toEqual([
      'Update **`Auth service`**: mark done',
      'Add node **`Rate limiter`** under **`Auth service`**',
    ]);
  });

  it('still says what a legacy payload with no titles would DO', () => {
    // `detect_output` is persisted, so a step parked before nodeTitles existed
    // replays a payload without them. Short ids are an acceptable loss; calling
    // an update a creation is not.
    expect(
      labels(detected({ nodeTitles: undefined }), [
        { op: 'upsert', nodeRef: KNOWN, status: 'done' },
      ]),
    ).toEqual(['Update **`aaaaaaaa…`**: mark done']);
  });
});
