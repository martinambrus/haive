import { describe, expect, it } from 'vitest';
import { parsePlanPatch, resolveTaskProposal } from './_plan-prompt.js';

/**
 * The offer a plan chat makes after writing a multi-node change.
 *
 * The property under test is that resolution happens AFTER the patch: most of a
 * proposal's refs name nodes the same reply created, which have no uuid until
 * the applier hands back its ref map. Everything else here is about the offer
 * costing the user nothing when it is malformed — the plan is already written by
 * the time this runs, so a bad proposal must lose the button and nothing else.
 */

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

const base = {
  title: 'Comms layer plus the two things on top',
  description: 'Build the external comms layer, then the UX and the workflow.',
  role: 'implements' as const,
  reason: 'Both wait on comms, so one task builds it first and then runs them together.',
};

describe('resolveTaskProposal', () => {
  it('resolves a temp ref through the applier ref map', () => {
    const resolved = resolveTaskProposal(
      { ...base, nodeRefs: ['tmp-comms'] },
      {
        'tmp-comms': UUID_A,
      },
    );
    expect(resolved?.proposal.nodeRefs).toEqual([UUID_A]);
    expect(resolved?.droppedRefs).toEqual([]);
  });

  it('keeps a uuid the agent copied out of the plan it was shown', () => {
    const resolved = resolveTaskProposal({ ...base, nodeRefs: [UUID_A] }, {});
    expect(resolved?.proposal.nodeRefs).toEqual([UUID_A]);
  });

  it('strips the node: marker the renderer prints ids with', () => {
    // The contract tells agents to COPY ids, and every id in the rendered plan
    // carries the marker — so obeying the instructions produces this exact ref.
    const resolved = resolveTaskProposal({ ...base, nodeRefs: [`node:${UUID_A}`] }, {});
    expect(resolved?.proposal.nodeRefs).toEqual([UUID_A]);
  });

  it('mixes created and existing nodes in one offer', () => {
    const resolved = resolveTaskProposal(
      { ...base, nodeRefs: ['tmp-ux', UUID_B] },
      {
        'tmp-ux': UUID_A,
      },
    );
    expect(resolved?.proposal.nodeRefs).toEqual([UUID_A, UUID_B]);
  });

  it('drops a ref that names nothing, and REPORTS it', () => {
    const resolved = resolveTaskProposal({ ...base, nodeRefs: [UUID_A, 'tmp-typo'] }, {});
    expect(resolved?.proposal.nodeRefs).toEqual([UUID_A]);
    expect(resolved?.droppedRefs).toEqual(['tmp-typo']);
  });

  it('dedupes a node named twice', () => {
    const resolved = resolveTaskProposal(
      { ...base, nodeRefs: ['tmp-a', UUID_A] },
      {
        'tmp-a': UUID_A,
      },
    );
    expect(resolved?.proposal.nodeRefs).toEqual([UUID_A]);
  });

  it('returns null when nothing resolved — an offer to start no nodes is not one', () => {
    expect(resolveTaskProposal({ ...base, nodeRefs: ['tmp-a', 'tmp-b'] }, {})).toBeNull();
    expect(resolveTaskProposal({ ...base, nodeRefs: [] }, {})).toBeNull();
  });

  it('returns null for a proposal missing the fields the button needs', () => {
    expect(resolveTaskProposal({ nodeRefs: [UUID_A] }, {})).toBeNull();
    expect(resolveTaskProposal({ ...base, role: 'green-it', nodeRefs: [UUID_A] }, {})).toBeNull();
    expect(resolveTaskProposal({ ...base, title: '', nodeRefs: [UUID_A] }, {})).toBeNull();
  });

  it('returns null for anything that is not a proposal at all', () => {
    expect(resolveTaskProposal(undefined, {})).toBeNull();
    expect(resolveTaskProposal(null, {})).toBeNull();
    expect(resolveTaskProposal('start a task', {})).toBeNull();
    expect(resolveTaskProposal({ nodeRefs: 'tmp-a' }, {})).toBeNull();
  });

  it('carries the role the agent chose, including touched', () => {
    const resolved = resolveTaskProposal(
      { ...base, role: 'touched', nodeRefs: [UUID_A, UUID_B] },
      {},
    );
    expect(resolved?.proposal.role).toBe('touched');
  });
});

describe('parsePlanPatch with a proposal', () => {
  it('carries taskProposal through beside the ops', () => {
    const patch = parsePlanPatch(
      `\`\`\`json
{"summary":"split it up","ops":[],"taskProposal":{"nodeRefs":["${UUID_A}"],"title":"t","description":"d","role":"touched","reason":"r"}}
\`\`\``,
    );
    expect(patch?.taskProposal).toMatchObject({ nodeRefs: [UUID_A], role: 'touched' });
  });

  it('leaves the field absent when the agent offered nothing', () => {
    const patch = parsePlanPatch('```json\n{"summary":"just a tweak","ops":[]}\n```');
    expect(patch).not.toBeNull();
    expect(patch).not.toHaveProperty('taskProposal');
  });

  it('does not make an unusable proposal cost the patch its ops', () => {
    // The plan write is the important half. A proposal the schema rejects is
    // dropped by resolveTaskProposal, and the ops still apply.
    const patch = parsePlanPatch(
      '```json\n{"summary":"s","ops":[{"op":"delete","nodeRef":"x"}],"taskProposal":"nonsense"}\n```',
    );
    expect(patch?.ops).toHaveLength(1);
    expect(resolveTaskProposal(patch?.taskProposal, {})).toBeNull();
  });
});
