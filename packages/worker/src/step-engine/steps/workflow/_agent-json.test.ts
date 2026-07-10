import { describe, it, expect } from 'vitest';
import { hasAnyKey, parseAgentJson, parseReviewJson } from './_agent-json.js';
import { parseSpecAuditFindings } from './04a-spec-audit.js';
import { parseCodeAuditFindings } from './08c2-code-audit.js';
import { parseSimplifierOutput, parseFixupOutput } from './07a-code-simplify.js';
import {
  parseValidatorOutput,
  parseFixerOutput as parseValidateFixerOutput,
} from './07b-phase-4-validate.js';
import { parseBrowserTestOutput, parseChecklistOutput } from './08a-browser-verify.js';
import { parseTesterOutput } from './08b-test-management.js';

/** The JSON an agent quotes as evidence before emitting its own report. Anchoring on the
 *  first ```json fence parsed THIS as the report, and because every schema field
 *  defaults, it validated as a clean, empty, successful result. */
const EVIDENCE = '```json\n{"require":{"drupal/core":"^10"},"debug":true}\n```';

/** Evidence fence, then the agent's real answer. */
function quoted(report: string): string {
  return `Evidence:\n${EVIDENCE}\nMy report:\n\`\`\`json\n${report}\n\`\`\``;
}

describe('hasAnyKey', () => {
  it('accepts an object naming any listed key', () => {
    expect(hasAnyKey({ verdict: 'APPROVE' }, ['verdict', 'findings'])).toBe(true);
    expect(hasAnyKey({ findings: [] }, ['verdict', 'findings'])).toBe(true);
  });

  it('rejects an object naming none of them, and every non-object', () => {
    expect(hasAnyKey({ require: {} }, ['verdict', 'findings'])).toBe(false);
    expect(hasAnyKey({}, ['verdict', 'findings'])).toBe(false);
    expect(hasAnyKey([{ verdict: 'APPROVE' }], ['verdict'])).toBe(false);
    expect(hasAnyKey(null, ['verdict'])).toBe(false);
    expect(hasAnyKey('verdict', ['verdict'])).toBe(false);
  });
});

describe('parseAgentJson', () => {
  const accept = (c: unknown) => (hasAnyKey(c, ['ok']) ? (c as { ok: unknown }) : null);

  it('passes an already-parsed object straight to accept', () => {
    expect(parseAgentJson({ ok: 1 }, accept)).toEqual({ ok: 1 });
    expect(parseAgentJson({ nope: 1 }, accept)).toBeNull();
  });

  it('returns null for empty, non-string, non-object raw', () => {
    expect(parseAgentJson(null, accept)).toBeNull();
    expect(parseAgentJson('', accept)).toBeNull();
    expect(parseAgentJson(42, accept)).toBeNull();
  });

  it('skips a quoted candidate and takes the agent’s own', () => {
    expect(parseAgentJson(quoted('{"ok":true}'), accept)).toEqual({ ok: true });
  });
});

describe('parseReviewJson', () => {
  it('applies the verdict/findings gate', () => {
    const id = (c: unknown) => c as Record<string, unknown>;
    expect(parseReviewJson({ verdict: 'APPROVE' }, id)).toEqual({ verdict: 'APPROVE' });
    expect(parseReviewJson({ require: {} }, id)).toBeNull();
  });
});

// One case per parser that used to read the quoted evidence as the agent's answer.
// Each assertion is the finding, fix, failure or test that would otherwise vanish.
describe('an agent’s quoted JSON never stands in for its report', () => {
  it('04a spec audit reports the gap, not a clean spec', () => {
    const f = parseSpecAuditFindings(
      quoted('{"findings":[{"dimension":"gap","severity":"high","comment":"no rollback"}]}'),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('high');
  });

  it('08c2 code audit reports the defect, not clean code', () => {
    const f = parseCodeAuditFindings(
      quoted('{"findings":[{"severity":"critical","path":"a.ts","issue":"npe"}]}'),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('critical');
  });

  it('07a simplifier reports its changes, not "nothing to simplify"', () => {
    const s = parseSimplifierOutput(
      quoted('{"files_simplified":["a.ts"],"changes_made":["dedup"]}'),
    );
    expect(s!.filesSimplified).toEqual(['a.ts']);
    expect(s!.noChangesNeeded).toBe(false);
  });

  it('07a fixup reports the restore, not "no fixes"', () => {
    const f = parseFixupOutput(quoted('{"fixes_needed":true,"fixes_made":["restored guard"]}'));
    expect(f.fixesNeeded).toBe(true);
  });

  it('07b validator reports ISSUES_FOUND, not UNPARSEABLE', () => {
    const v = parseValidatorOutput(
      quoted(
        '{"verdict":"ISSUES_FOUND","issues":[{"severity":"high","description":"stale caller"}]}',
      ),
    );
    expect(v!.verdict).toBe('ISSUES_FOUND');
    expect(v!.issues).toHaveLength(1);
  });

  it('07b fixer reports its fixes, not "no fixes recorded"', () => {
    expect(parseValidateFixerOutput(quoted('{"fixes_made":["x"],"notes":"n"}')).fixesMade).toEqual([
      'x',
    ]);
  });

  it('08a browser tester reports the failure, not a pass', () => {
    const t = parseBrowserTestOutput(
      quoted('{"passed":false,"failures":[{"description":"500 on save"}]}'),
    );
    expect(t!.passed).toBe(false);
    expect(t!.failures).toHaveLength(1);
  });

  it('08a checklist prefers its own markdown but still falls back to raw prose', () => {
    expect(parseChecklistOutput(quoted('{"checklist_markdown":"# steps"}'))).toBe('# steps');
    // no JSON at all -> the agent wrote plain markdown; the fallback must survive
    expect(parseChecklistOutput('# plain markdown')).toBe('# plain markdown');
  });

  it('08b tester reports the tests it wrote, not "no tests"', () => {
    const t = parseTesterOutput(quoted('{"tests_created":["a.spec.ts"],"notes":"n"}'));
    expect(t.testsCreated).toEqual(['a.spec.ts']);
  });

  it('08b tester now salvages a repairable report (it had no jsonrepair pass before)', () => {
    expect(
      parseTesterOutput('```json\n{"tests_created":["a.spec.ts"],}\n```').testsCreated,
    ).toEqual(['a.spec.ts']);
  });

  it('a quoted object alone yields each parser’s empty/failed result', () => {
    expect(parseSpecAuditFindings(EVIDENCE)).toEqual([]);
    expect(parseCodeAuditFindings(EVIDENCE)).toEqual([]);
    expect(parseSimplifierOutput(EVIDENCE)).toBeNull();
    expect(parseValidatorOutput(EVIDENCE)).toBeNull();
    expect(parseBrowserTestOutput(EVIDENCE)).toBeNull();
    expect(parseTesterOutput(EVIDENCE).testsCreated).toEqual([]);
  });
});
