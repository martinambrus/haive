import { describe, expect, it } from 'vitest';
import {
  describePlanNodesForTask,
  PLAN_DESCRIPTION_BODY_BUDGET,
  type DescribableNode,
} from './describe.js';

/**
 * The description a task gets when its work came from the plan.
 *
 * What is asserted here is mostly about what must NOT happen: an empty
 * description reaches `heuristicTriage`, the triage agent, discovery and the
 * create endpoint's own refusal, so every path that could produce one is a bug
 * with four downstream symptoms and no obvious cause.
 */

const AI: DescribableNode = {
  id: 'ai',
  title: 'Ai/Bi (type 20): checkboxes on section II',
  body: 'Add the use_in_pdf checkbox per field and suppress it in the loader.',
  ancestry: ['Revisions module', 'Gas inspections'],
};
const AH: DescribableNode = {
  id: 'ah',
  title: 'Ah/Bh (type 21): checkboxes on sections III and IV',
  body: 'Patch by array key, not by Roman numeral.',
  ancestry: ['Revisions module', 'Gas inspections'],
};

describe('describePlanNodesForTask', () => {
  it('returns empty for no nodes, so a caller needs no second test', () => {
    expect(describePlanNodesForTask([])).toBe('');
  });

  it('describes ONE node — the single-node create path', () => {
    const out = describePlanNodesForTask([AI]);
    expect(out).toContain('Implement this part of the project plan.');
    expect(out).toContain('## Ai/Bi (type 20): checkboxes on section II');
    expect(out).toContain('use_in_pdf checkbox per field');
    expect(out).toContain('_In: Revisions module › Gas inspections_');
    // No order section when there is nothing to order.
    expect(out).not.toContain('Build order');
  });

  it('counts the parts when there are several', () => {
    expect(describePlanNodesForTask([AI, AH])).toContain('these 2 parts of the project plan');
  });

  it('states the build order as a requirement, in the right direction', () => {
    const out = describePlanNodesForTask([AI, AH], [{ fromNodeId: 'ah', toNodeId: 'ai' }]);
    expect(out).toContain('## Build order');
    expect(out).toContain(
      '- "Ai/Bi (type 20): checkboxes on section II" must land before "Ah/Bh (type 21): checkboxes on sections III and IV".',
    );
    expect(out).toContain('Everything not named above can be built in parallel.');
  });

  it('repeats the prerequisite on the node that waits', () => {
    const out = describePlanNodesForTask([AI, AH], [{ fromNodeId: 'ah', toNodeId: 'ai' }]);
    const ahBlock = out.slice(out.indexOf('## Ah/Bh'));
    expect(ahBlock).toContain(
      'Cannot start until "Ai/Bi (type 20): checkboxes on section II" is done.',
    );
    const aiBlock = out.slice(out.indexOf('## Ai/Bi'), out.indexOf('## Ah/Bh'));
    expect(aiBlock).not.toContain('Cannot start until');
  });

  it('groups several prerequisites on one node', () => {
    const third: DescribableNode = { id: 'x', title: 'Spec', body: null };
    const out = describePlanNodesForTask(
      [AI, AH, third],
      [
        { fromNodeId: 'x', toNodeId: 'ai' },
        { fromNodeId: 'x', toNodeId: 'ah' },
      ],
    );
    expect(out).toContain('must land before "Spec".');
    expect(out.match(/must land before "Spec"/g)).toHaveLength(1);
  });

  it('IGNORES a dependency pointing outside the set', () => {
    // Another task's problem — the create gate already refused this task if such
    // a prerequisite were outstanding, and naming it reads as scope.
    const out = describePlanNodesForTask([AI], [{ fromNodeId: 'ai', toNodeId: 'somewhere-else' }]);
    expect(out).not.toContain('Build order');
    expect(out).not.toContain('Cannot start until');
  });

  it('says so when a node carries no body, rather than emitting a blank section', () => {
    const out = describePlanNodesForTask([{ id: 'n', title: 'Empty', body: null }]);
    expect(out).toContain('_This node has no description in the plan yet._');
  });

  it('never returns an empty string for a node that exists', () => {
    // The whole point. Whatever the node is missing, the task still gets a
    // description — an empty one is refused by the create endpoint and makes
    // triage classify blind.
    expect(describePlanNodesForTask([{ id: 'n', title: 'T', body: null }]).trim()).not.toBe('');
    expect(describePlanNodesForTask([{ id: 'n', title: 'T', body: '   ' }]).trim()).not.toBe('');
  });

  it('STATES that it truncated an over-long body', () => {
    const out = describePlanNodesForTask([
      { id: 'n', title: 'Huge', body: 'x'.repeat(PLAN_DESCRIPTION_BODY_BUDGET + 500) },
    ]);
    expect(out).toContain('truncated here');
    expect(out).toContain('read the full node in the plan');
  });

  it('leaves a body inside the budget byte-identical', () => {
    const body = 'y'.repeat(PLAN_DESCRIPTION_BODY_BUDGET);
    const out = describePlanNodesForTask([{ id: 'n', title: 'Exact', body }]);
    expect(out).toContain(body);
    expect(out).not.toContain('truncated here');
  });

  it('omits the ancestry line when the caller has none', () => {
    expect(describePlanNodesForTask([{ id: 'n', title: 'T', body: 'b' }])).not.toContain('_In:');
  });
});
