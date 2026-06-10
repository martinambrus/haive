import { describe, it, expect } from 'vitest';
import { parseInsights } from './08e-insights-triage.js';

describe('parseInsights', () => {
  it('parses INSIGHT lines after a ## INSIGHTS heading', () => {
    const raw =
      '```json\n{"summary":"x"}\n```\n\n## INSIGHTS\n- INSIGHT: Extract helper | src/a.ts:10 | dedupe the two loops\n- INSIGHT: Add index | db/schema.ts:5 | speeds the query\n';
    const ins = parseInsights([{ stepId: '07-phase-2-implement', raw }]);
    expect(ins).toHaveLength(2);
    expect(ins[0]!.title).toBe('Extract helper');
    expect(ins[0]!.location).toBe('src/a.ts:10');
    expect(ins[0]!.description).toBe('dedupe the two loops');
    expect(ins[0]!.sourceStep).toBe('07-phase-2-implement');
    expect(ins[0]!.id).toBe('i-1');
  });

  it('dedupes by title+location across outputs and caps ids sequentially', () => {
    const raw = '## INSIGHTS\n- INSIGHT: Same | a.ts:1 | one\n';
    const ins = parseInsights([
      { stepId: 's1', raw },
      { stepId: 's2', raw },
    ]);
    expect(ins).toHaveLength(1);
  });

  it('handles a title-only insight (no location/description)', () => {
    const ins = parseInsights([{ stepId: 's', raw: '## INSIGHTS\n- INSIGHT: Tidy logging\n' }]);
    expect(ins).toHaveLength(1);
    expect(ins[0]!.title).toBe('Tidy logging');
    expect(ins[0]!.location).toBe('');
  });

  it('returns empty when there is no INSIGHTS section', () => {
    expect(parseInsights([{ stepId: 's', raw: 'just output, no insights' }])).toEqual([]);
    expect(parseInsights([{ stepId: 's', raw: '' }])).toEqual([]);
    expect(parseInsights([])).toEqual([]);
  });
});
