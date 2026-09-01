import { describe, it, expect } from 'vitest';
import {
  planMirrorPayloadSchema,
  planPatchSchema,
  rollUpStatus,
  type PlanNodeStatus,
} from './plan.js';

const ROOT_ID = '11111111-1111-4111-8111-111111111111';
const CHILD_ID = '22222222-2222-4222-8222-222222222222';

function portableMirror() {
  return {
    schemaVersion: 2 as const,
    nodes: [
      {
        id: ROOT_ID,
        parentId: null,
        ordinal: 0,
        title: 'Product',
        kind: 'component',
        body: '# Product plan',
        status: 'in_progress',
        taskable: false,
      },
      {
        id: CHILD_ID,
        parentId: ROOT_ID,
        ordinal: 0,
        title: 'API',
        kind: 'component',
        body: 'Portable description',
        status: 'todo',
        taskable: true,
      },
    ],
    edges: [
      {
        fromNodeId: CHILD_ID,
        toNodeId: ROOT_ID,
        kind: 'implements',
        note: 'The API implements the product contract',
      },
    ],
    codeLinks: [
      {
        nodeId: CHILD_ID,
        repoPath: 'src/api/index.ts',
        symbol: 'createApi',
        evidence: 'API entry point',
        derivedAtCommit: '0123456789abcdef0123456789abcdef01234567',
        stale: true,
      },
    ],
  };
}

describe('planMirrorPayloadSchema', () => {
  it('accepts the complete v2 portable plan product state', () => {
    expect(planMirrorPayloadSchema.parse(portableMirror())).toEqual(portableMirror());
  });

  it('keeps the shipped v1 node-and-edge snapshot readable', () => {
    const value = portableMirror();
    const legacy = {
      schemaVersion: 1,
      nodes: value.nodes.map((node) => ({ ...node, createdBy: 'llm' })),
      edges: value.edges,
    };
    expect(planMirrorPayloadSchema.parse(legacy)).toEqual(legacy);
  });

  it('rejects machine-escaping code paths', () => {
    const value = portableMirror();
    value.codeLinks[0]!.repoPath = '../outside-the-repository';
    expect(() => planMirrorPayloadSchema.parse(value)).toThrow();
  });

  it('rejects chat, task, origin and version metadata at the snapshot boundary', () => {
    const withChat = { ...portableMirror(), messages: [{ body: 'transient chat' }] };
    const withTask = {
      ...portableMirror(),
      nodes: [{ ...portableMirror().nodes[0], sourceTaskId: ROOT_ID }],
    };
    const withVersion = {
      ...portableMirror(),
      nodes: [{ ...portableMirror().nodes[0], version: 3, createdBy: 'llm' }],
    };
    expect(() => planMirrorPayloadSchema.parse(withChat)).toThrow();
    expect(() => planMirrorPayloadSchema.parse(withTask)).toThrow();
    expect(() => planMirrorPayloadSchema.parse(withVersion)).toThrow();
  });
});

describe('rollUpStatus', () => {
  it('returns the node own status when it is a leaf', () => {
    for (const s of [
      'todo',
      'in_progress',
      'blocked_human',
      'done',
      'not_applicable',
    ] as PlanNodeStatus[]) {
      expect(rollUpStatus(s, [])).toBe(s);
    }
  });

  it('propagates blocked_human upward from any depth', () => {
    expect(rollUpStatus('done', ['done', 'blocked_human'])).toBe('blocked_human');
    expect(rollUpStatus('todo', ['blocked_human'])).toBe('blocked_human');
  });

  it('blocks even when every other descendant is settled', () => {
    expect(rollUpStatus('in_progress', ['done', 'not_applicable', 'blocked_human'])).toBe(
      'blocked_human',
    );
  });

  it('does not let not_applicable prevent green', () => {
    expect(rollUpStatus('in_progress', ['done', 'not_applicable', 'done'])).toBe('done');
    expect(rollUpStatus('todo', ['not_applicable', 'not_applicable'])).toBe('done');
  });

  it('stays not_applicable when the node itself is written off', () => {
    expect(rollUpStatus('not_applicable', ['done', 'not_applicable'])).toBe('not_applicable');
    expect(rollUpStatus('not_applicable', ['todo'])).toBe('not_applicable');
  });

  it('is not green while any descendant is outstanding', () => {
    expect(rollUpStatus('done', ['done', 'todo'])).toBe('in_progress');
    expect(rollUpStatus('todo', ['todo', 'todo'])).toBe('todo');
    expect(rollUpStatus('todo', ['todo', 'in_progress'])).toBe('in_progress');
  });
});

describe('planPatchSchema', () => {
  it('accepts a subtree created and linked in one turn via temp refs', () => {
    const parsed = planPatchSchema.parse({
      ops: [
        { op: 'upsert', nodeRef: 'tmp-root', parentRef: null, title: 'Product' },
        { op: 'upsert', nodeRef: 'tmp-api', parentRef: 'tmp-root', title: 'API' },
        { op: 'link', fromRef: 'tmp-api', toRef: 'tmp-root', kind: 'implements' },
      ],
    });
    expect(parsed.ops).toHaveLength(3);
  });

  it('keeps absent and explicitly-null parentRef distinguishable', () => {
    const parsed = planPatchSchema.parse({
      ops: [
        { op: 'upsert', nodeRef: 'a', title: 'no parent key' },
        { op: 'upsert', nodeRef: 'b', parentRef: null, title: 'explicit root' },
      ],
    });
    const [absent, explicit] = parsed.ops as [
      { parentRef?: string | null },
      { parentRef?: string | null },
    ];
    // "leave the parent alone" vs "this is the root" must not collapse into one
    // value — the applier branches on exactly this difference.
    expect('parentRef' in absent).toBe(false);
    expect(explicit.parentRef).toBeNull();
  });

  it('rejects an unknown op rather than silently dropping it', () => {
    expect(() => planPatchSchema.parse({ ops: [{ op: 'reparent', nodeRef: 'a' }] })).toThrow();
  });

  it('rejects a patch over the op cap', () => {
    const ops = Array.from({ length: 501 }, (_, i) => ({
      op: 'upsert' as const,
      nodeRef: `n${i}`,
      parentRef: null,
      title: `n${i}`,
    }));
    expect(() => planPatchSchema.parse({ ops })).toThrow();
  });
});
