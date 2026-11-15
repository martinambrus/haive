import { describe, expect, it } from 'vitest';
import {
  buildDataEdgePlan,
  parseDataEdgePlan,
  resolveDataInput,
  MAX_DATA_EDGE_STEPS,
} from '../src/step-engine/data-edge-plan.js';
import { dataPortNodes, SPEC_INPUTS } from '../src/step-engine/core-data-ports.js';
import { SPEC_ROLES, STEP_ROLE_REGISTRY } from '../src/step-engine/output-contracts.js';
const draft = STEP_ROLE_REGISTRY[SPEC_ROLES.draft].legacyStepId;
const checked = STEP_ROLE_REGISTRY[SPEC_ROLES.checked].legacyStepId;
const nodes = () => dataPortNodes([draft, checked, '07-phase-2-implement']);
const plan = () => buildDataEdgePlan('static', [{ executionPath: null, nodes: nodes() }]);
describe('v3 immutable per-consumer data plan', () => {
  it('pins each consumer input, optional absence, exact producer position and contract', () => {
    const p = plan();
    expect(p.version).toBe(3);
    expect(parseDataEdgePlan(JSON.parse(JSON.stringify(p)))).toEqual(p);
    expect(p.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(p.candidates[0]!.bindings['1:draft']).toMatchObject({
      producerIndex: 0,
      producerStepId: draft,
    });
    expect(p.candidates[0]!.bindings['2:resolved']).toBeNull();
    expect(p.candidates[0]!.bindings['2:checked']).toMatchObject({
      producerIndex: 1,
      producerStepId: checked,
    });
  });
  it('refuses missing/malformed pins and never chooses a candidate on behalf of triage', () => {
    const p = plan();
    delete p.candidates[0]!.bindings['1:draft'];
    expect(() => parseDataEdgePlan(p)).toThrow('invalid-data-edge-plan');
    expect(() => parseDataEdgePlan({ version: 3 })).toThrow('invalid-data-edge-plan');
    const derived = buildDataEdgePlan('derived', [
      { executionPath: null, nodes: nodes() },
      { executionPath: 'quick_bugfix', nodes: nodes() },
    ]);
    expect(
      resolveDataInput({ dataEdgePlan: derived, executionPath: null }, checked, 'draft'),
    ).toEqual({ state: 'unselected' });
    expect(() =>
      resolveDataInput({ dataEdgePlan: derived, executionPath: 'missing' }, checked, 'draft'),
    ).toThrow('invalid-data-edge-plan');
    expect(() => resolveDataInput({ dataEdgePlan: plan() }, checked, 'missing')).toThrow(
      'invalid-data-edge-plan',
    );
  });
  it('refuses ambiguous and required dangling edges before producing a plan', () => {
    const n = nodes();
    const duplicate = { ...n[0]!, id: 'another-producer' };
    expect(() =>
      buildDataEdgePlan('static', [{ executionPath: null, nodes: [n[0]!, duplicate, n[1]!] }]),
    ).toThrow('ambiguous');
    n[1]!.inputs[0]!.optional = false;
    expect(() => buildDataEdgePlan('static', [{ executionPath: null, nodes: [n[1]!] }])).toThrow(
      'dangling',
    );
  });
  it('bounds admission independently of the projection route, before validation', () => {
    expect(MAX_DATA_EDGE_STEPS).toBe(256);
    expect(() => buildDataEdgePlan('static', [{ executionPath: null, nodes: nodes() }], 2)).toThrow(
      'step-count',
    );
  });
  it('pins 06 and 08b stage names and optional flags in the shared table', () => {
    for (const id of ['06-run-config', '08b-test-management'])
      expect(SPEC_INPUTS[id]!.map((i) => [i.input, i.optional])).toEqual([
        ['resolved', true],
        ['checked', true],
        ['draft', true],
      ]);
  });
});
