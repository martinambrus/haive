import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseKbEntriesWithDiagnostic } from '../src/step-engine/steps/onboarding/08-knowledge-acquisition.js';
import { parseLlmAgentOutputWithDiagnostic } from '../src/step-engine/steps/onboarding/06_5-agent-discovery.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const kbCorruptBody = readFileSync(path.join(fixturesDir, 'kb-corrupt-body.txt'), 'utf8');
const agentCorruptBody = readFileSync(path.join(fixturesDir, 'agent-corrupt-body.txt'), 'utf8');

describe('parseKbEntriesWithDiagnostic — jsonrepair salvage', () => {
  it('clean fence body parses without invoking repair', () => {
    const clean =
      '```json\n{"entries":[{"id":"a","title":"A","sections":[{"heading":"h","body":"b"}]}]}\n```';
    const { entries, diagnostic } = parseKbEntriesWithDiagnostic(clean);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe('a');
    expect(diagnostic).toBeNull();
  });

  it('salvages entries from a body that strict JSON.parse rejects', () => {
    const { entries, diagnostic } = parseKbEntriesWithDiagnostic(kbCorruptBody);
    // Prior failing run: model dropped a leading `"` mid-entry. Strict JSON.parse
    // failed at position ~359; jsonrepair should still recover most entries.
    expect(entries.length).toBeGreaterThanOrEqual(8);
    expect(diagnostic?.repaired).toBe(true);
    expect(diagnostic?.parseError).toMatch(/Expected double-quoted property name/);
    expect(diagnostic?.recoveredCount).toBeGreaterThan(0);
  });

  it('returns a no-repair diagnostic when the body is unrecoverable', () => {
    const garbage = '```json\nthis is not json at all, not even close\n```';
    const { entries, diagnostic } = parseKbEntriesWithDiagnostic(garbage);
    expect(entries).toHaveLength(0);
    expect(diagnostic?.repaired).toBeFalsy();
  });
});

describe('parseLlmAgentOutputWithDiagnostic — jsonrepair salvage', () => {
  it('salvages predefined + custom from a body that strict JSON.parse rejects', () => {
    const { result, diagnostic } = parseLlmAgentOutputWithDiagnostic(agentCorruptBody);
    expect(result).not.toBeNull();
    expect(Object.keys(result?.predefined ?? {})).toHaveLength(10);
    expect(result?.custom?.length).toBeGreaterThanOrEqual(2);
    expect(diagnostic?.repaired).toBe(true);
    // Strict error captured from whichever fence layout we tried last —
    // both flavors are valid signals that the model emitted invalid JSON.
    expect(diagnostic?.parseError).toMatch(
      /Expected '?,'? or '?\]'?|Unterminated string|position \d+/,
    );
  });

  it('clean body returns no diagnostic', () => {
    const clean = '```json\n{"predefined":{"a":true},"custom":[{"id":"x","label":"X"}]}\n```';
    const { result, diagnostic } = parseLlmAgentOutputWithDiagnostic(clean);
    expect(result?.predefined).toEqual({ a: true });
    expect(result?.custom).toHaveLength(1);
    expect(diagnostic).toBeNull();
  });
});
