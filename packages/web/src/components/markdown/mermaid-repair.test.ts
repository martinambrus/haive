import { describe, expect, it } from 'vitest';
import { repairFlowchartLabelParens, repairSequenceSemicolons } from './mermaid-repair';

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

// The exact shape that fell back to raw <pre> on a gate-1 spec: `(` inside a
// pipe edge label is a shape delimiter, so mermaid@11 aborts with `got 'PS'`.
const FAILING_FLOW = [
  'graph LR',
  '  Br[Browser] -->|http/https both served| Rtr[DDEV router]',
  '  F --> M[(MariaDB 10.11<br/>db schema utf8_bin)]',
  '  F -->|mail()| MP[Mailpit]',
].join('\n');

describe('repairFlowchartLabelParens', () => {
  it('escapes parens in a pipe edge label to the mermaid entities', () => {
    const out = repairFlowchartLabelParens(FAILING_FLOW);
    expect(out).not.toBeNull();
    expect(out).toContain('F -->|mail#40;#41;| MP[Mailpit]');
  });

  it('leaves the cylinder shape delimiters intact', () => {
    const out = repairFlowchartLabelParens(FAILING_FLOW)!;
    expect(out).toContain('M[(MariaDB 10.11<br/>db schema utf8_bin)]');
  });

  it('escapes parens inside a square node label', () => {
    const out = repairFlowchartLabelParens('flowchart LR\n  A[php-fpm (5.6)] --> B[x]');
    expect(out).toContain('A[php-fpm #40;5.6#41;] --> B[x]');
  });

  it('leaves an already-quoted label alone', () => {
    expect(repairFlowchartLabelParens('graph LR\n  A["php-fpm (5.6)"] --> B[x]')).toBeNull();
  });

  it('returns null when there is nothing to fix', () => {
    expect(repairFlowchartLabelParens('graph LR\n  A(round) --> B[x]')).toBeNull();
  });

  it('returns null for non-flowchart diagrams', () => {
    expect(repairFlowchartLabelParens('sequenceDiagram\n  A->>B: mail()')).toBeNull();
  });

  it('is idempotent — escaped entities are not re-escaped', () => {
    const once = repairFlowchartLabelParens(FAILING_FLOW)!;
    expect(repairFlowchartLabelParens(once)).toBeNull();
  });
});
