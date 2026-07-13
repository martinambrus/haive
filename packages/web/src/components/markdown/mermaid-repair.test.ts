import { describe, expect, it } from 'vitest';
import { repairSequenceSemicolons } from './mermaid-repair';

// The exact shape that fell back to raw <pre>: a bare `;` in a message aborts
// mermaid's strict parser (verified live against mermaid@11).
const FAILING = [
  'sequenceDiagram',
  '  participant Dev',
  '  participant Web as web (php5.6-fpm + apache)',
  '  Dev->>Web: ddev start; open .ddev.site',
].join('\n');

describe('repairSequenceSemicolons', () => {
  it('escapes a bare ; in sequence message text to the mermaid #59; entity', () => {
    const out = repairSequenceSemicolons(FAILING);
    expect(out).not.toBeNull();
    expect(out).toContain('Dev->>Web: ddev start#59; open .ddev.site');
    expect(out).not.toContain('start; open'); // no bare semicolon left
  });

  it('returns null for a sequence diagram with no semicolons (nothing to fix)', () => {
    expect(repairSequenceSemicolons('sequenceDiagram\n  A->>B: hi')).toBeNull();
  });

  it('returns null for non-sequence diagrams where ; is a valid separator', () => {
    expect(repairSequenceSemicolons('graph TD; A-->B; B-->C')).toBeNull();
    expect(repairSequenceSemicolons('flowchart LR\n  A-->B; B-->C')).toBeNull();
  });

  it('is idempotent — an already-escaped #59; entity is not double-escaped', () => {
    const once = repairSequenceSemicolons(FAILING)!;
    expect(repairSequenceSemicolons(once)).toBeNull();
  });

  it('ignores leading blank lines when detecting the diagram type', () => {
    const out = repairSequenceSemicolons('\n\nsequenceDiagram\n  A->>B: x; y');
    expect(out).toContain('A->>B: x#59; y');
  });
});
