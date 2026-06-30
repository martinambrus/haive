import { describe, it, expect } from 'vitest';
import {
  salvageImplementOutput,
  parseImplementOutput,
  phase2ImplementStep,
} from './07-phase-2-implement.js';

// Mirrors the real round-2 (browser-testing fix pass) output that exposed the bug:
// the agent emitted a verification-report JSON with NO top-level `summary` key (so the
// strict parseImplementOutput returns null), wrapped in prose. salvage must recover the
// prose + files instead of letting apply fall to the misleading "skipped" stub.
const BROWSER_VERIFY_FIX_OUTPUT = [
  'Chrome is not available in this environment — browser verification is not possible.',
  '',
  'Here is the complete result:',
  '',
  '```json',
  JSON.stringify(
    {
      status: 'done',
      defect: 'browser keeps reloading the first installation page after language selection',
      root_cause: 'ThemeManager::getBack2HTTP() emits an https->http redirect on every page',
      fix: { file: 'init.php', line_added: 40, change: 'Added $NO_SSL_GETBACK = true;' },
      files_changed: ['init.php'],
      lines_changed: 2,
      browser_verified: false,
    },
    null,
    2,
  ),
  '```',
  '',
  '**What changed**: init.php line 40 — added $NO_SSL_GETBACK = true; below the WEBSITE_URL define.',
  '**Why this fixes it**: getBack2HTTP() checks !$NO_SSL_GETBACK first, so the redirect JS is never emitted.',
].join('\n');

describe('salvageImplementOutput', () => {
  it('salvages summary + files from a browser-verify fix-pass report (no top-level summary key)', () => {
    const s = salvageImplementOutput(BROWSER_VERIFY_FIX_OUTPUT);
    expect(s).not.toBeNull();
    expect(s!.filesTouched).toEqual(['init.php']);
    // The real prose recap survives, not the canned stub.
    expect(s!.summary).toContain('What changed');
    expect(s!.summary).toContain('init.php');
    expect(s!.summary.toLowerCase()).not.toContain('skipped');
    // The fenced JSON block is stripped from the salvaged prose.
    expect(s!.summary).not.toContain('```');
    expect(s!.summary).not.toContain('files_changed');
  });

  it('returns null on genuinely empty output so the caller emits the honest no-output stub', () => {
    expect(salvageImplementOutput(null)).toBeNull();
    expect(salvageImplementOutput('')).toBeNull();
    expect(salvageImplementOutput('   ')).toBeNull();
  });

  it('pulls files from an already-parsed off-schema object and still gives a summary', () => {
    const s = salvageImplementOutput({ status: 'done', files_changed: ['a.php', 'b.php'] });
    expect(s).not.toBeNull();
    expect(s!.filesTouched).toEqual(['a.php', 'b.php']);
    expect(s!.summary.length).toBeGreaterThan(0);
  });

  it('prefers an explicit summary field and tolerates the `files` key', () => {
    const s = salvageImplementOutput('```json\n{"summary":"did the thing","files":["x.ts"]}\n```');
    expect(s!.summary).toBe('did the thing');
    expect(s!.filesTouched).toEqual(['x.ts']);
  });

  it('caps an overlong salvaged summary', () => {
    const s = salvageImplementOutput('x'.repeat(5000));
    expect(s).not.toBeNull();
    expect(s!.summary.length).toBeLessThanOrEqual(2000);
  });
});

describe('phase2ImplementStep fix-pass browser guidance', () => {
  const detect = (over: Record<string, unknown>) => ({
    specSummary: '',
    spec: 'spec',
    sandboxWorkspacePath: '/ws',
    gateFeedback: '',
    fixContext: null,
    fixIsHuman: false,
    priorFixContext: '',
    round: 0,
    browserTesting: false,
    ...over,
  });
  const prompt = (over: Record<string, unknown>) =>
    phase2ImplementStep.llm!.buildPrompt({ detected: detect(over), formValues: {} } as never);

  it('adds reproduce-and-verify browser steps on a fix pass when browserTesting is on', () => {
    const p = prompt({ fixContext: 'DB error on the homepage', round: 1, browserTesting: true });
    expect(p).toContain('chrome-devtools');
    expect(p).toContain('REPRODUCE');
  });

  it('omits the browser block on the original pass (no fixContext)', () => {
    const p = prompt({ fixContext: null, round: 0, browserTesting: true });
    expect(p).not.toContain('=== Verify in the browser');
  });

  it('frames a human-sourced reject as an authoritative directive, not filterable tool output', () => {
    const p = prompt({
      fixContext: 'deprecation notices + infinite reload',
      round: 1,
      fixIsHuman: true,
    });
    expect(p).toContain('AUTHORITATIVE DIRECTIVE');
    expect(p).toContain('framework-native'); // the exact dismissal we must forbid
    expect(p).toContain('never silently skip a reported');
    // The machine "extract the real error and ignore the rest" caveat must NOT appear.
    expect(p).not.toContain('raw tool/agent output');
  });

  it('keeps the filter-the-noise framing for a machine-sourced diagnosis', () => {
    const p = prompt({ fixContext: 'curl: (7) Failed to connect', round: 1, fixIsHuman: false });
    expect(p).toContain('raw tool/agent output');
    expect(p).not.toContain('AUTHORITATIVE DIRECTIVE');
  });
});

describe('parseImplementOutput environmentFindings', () => {
  it('captures environmentFindings from the agent JSON', () => {
    const out = parseImplementOutput(
      '```json\n{"summary":"did x","filesTouched":["a.ts"],"notes":"n","environmentFindings":"ddev not on PATH"}\n```',
    );
    expect(out).not.toBeNull();
    expect(out!.environmentFindings).toBe('ddev not on PATH');
  });

  it('defaults environmentFindings to empty when absent', () => {
    const out = parseImplementOutput('```json\n{"summary":"did x"}\n```');
    expect(out).not.toBeNull();
    expect(out!.environmentFindings).toBe('');
  });
});

describe('phase2ImplementStep prior-fix-rounds ledger', () => {
  const detect = (over: Record<string, unknown>) => ({
    specSummary: '',
    spec: 'spec',
    sandboxWorkspacePath: '/ws',
    gateFeedback: '',
    fixContext: null,
    fixIsHuman: false,
    priorFixContext: '',
    round: 0,
    browserTesting: false,
    ...over,
  });
  const prompt = (over: Record<string, unknown>) =>
    phase2ImplementStep.llm!.buildPrompt({ detected: detect(over), formValues: {} } as never);

  it('injects the prior-fix-rounds background block on a fix pass when present', () => {
    const p = prompt({
      fixContext: 'DB error on homepage',
      round: 2,
      priorFixContext: 'round 1: tried X; ddev not on PATH in sandbox',
    });
    expect(p).toContain('Prior fix rounds (background)');
    expect(p).toContain('round 1: tried X; ddev not on PATH in sandbox');
  });

  it('omits the prior-fix block when priorFixContext is empty', () => {
    const p = prompt({ fixContext: 'DB error', round: 1, priorFixContext: '' });
    expect(p).not.toContain('Prior fix rounds (background)');
  });
});
