import { describe, expect, it } from 'vitest';
import { sectionAgentId, sectionHandled } from '../src/step-engine/steps/plan/02-plan-coverage.js';
import type { CoverageCandidate } from '../src/step-engine/steps/plan/plan-coverage-scan.js';

/** `task_step_agent_minings.agent_id` is varchar(128). */
const AGENT_ID_MAX = 128;

const candidate = (source: string, sourceId?: string): CoverageCandidate => ({
  title: 'Billing',
  line: 12,
  source,
  sourceId,
  missingTerms: [],
  matchedNodes: 0,
  score: 0,
});

// An input recorded without a row id keys by its path, and a path can run to 400 characters.
const longPath = `${'specification/'.repeat(28)}billing.md`;

describe('sectionAgentId', () => {
  it('fits agent_id with its round suffix, however long the key', () => {
    const key = `doc:${longPath}:12`;
    expect(key.length).toBeGreaterThan(AGENT_ID_MAX);
    expect(`${sectionAgentId(key)}-r99`.length).toBeLessThanOrEqual(AGENT_ID_MAX);
    expect(sectionAgentId(key)).toBe(sectionAgentId(key));
    expect(sectionAgentId(`doc:${longPath}:13`)).not.toBe(sectionAgentId(key));
  });

  it('keeps a key that fits as it always was', () => {
    expect(sectionAgentId('doc:3f2a:12')).toBe('cover-doc-3f2a-12');
  });
});

describe('sectionHandled', () => {
  it('matches a repair recorded under the hashed id', () => {
    const c = candidate(longPath);
    expect(sectionHandled(new Set([sectionAgentId(`doc:${longPath}:12`)]), c)).toBe(true);
  });

  it('still matches a long raw id that fit once its round was appended', () => {
    const path = 'p'.repeat(110);
    const raw = `cover-doc-${path}-12`;
    expect(raw.length).toBeGreaterThan(120);
    expect(`${raw}-r1`.length).toBeLessThanOrEqual(AGENT_ID_MAX);
    expect(sectionHandled(new Set([raw]), candidate(path))).toBe(true);
  });
});
