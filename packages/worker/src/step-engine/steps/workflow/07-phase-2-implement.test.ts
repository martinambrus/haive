import { describe, it, expect } from 'vitest';
import { schema } from '@haive/database';
import type { StepContext } from '../../step-definition.js';
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

// The fix loop re-enters at this step by a hardcoded target, and this step is the only
// reader of the diagnosis — so a DAG task that skipped every fix round burned its whole
// round budget re-running the review chain against unchanged code (task 681f0f99).
// The inverse costs as much: the round counter is shared with the revise loop, so keying
// on `round > 0` ran a second full implementation on top of a finished DAG build whenever
// a human had rejected the spec at gate 1 (task ef954a3d).
function shouldRunDb(mode: string | null, requestedRounds: FixRequest[]) {
  const stepRows = mode === null ? [] : [{ detectOutput: null, output: { mode }, iterations: [] }];
  const eventRows = requestedRounds.map((r) => ({
    payload: { round: r.round, diagnosis: r.diagnosis ?? 'tests failed' },
  }));
  let rows: unknown[] = stepRows;
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain,
    from: (table: unknown) => {
      rows = table === schema.taskEvents ? eventRows : stepRows;
      return chain;
    },
    where: () => chain,
    orderBy: () => chain,
    limit: async () => rows,
    // isFixRound awaits the builder directly (no .limit); loadPreviousStepOutput ends at
    // .limit(1). Both have to resolve off the same fake.
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
  });
  return chain;
}

interface FixRequest {
  round: number;
  diagnosis?: string;
}

const shouldRunCtx = (mode: string | null, round: number, requested: FixRequest[] = []) =>
  ({ db: shouldRunDb(mode, requested), taskId: 't1', round }) as unknown as StepContext;

describe('07 shouldRun', () => {
  it('skips the initial DAG build — 06c-dag-execute implements it', async () => {
    expect(await phase2ImplementStep.shouldRun!(shouldRunCtx('dag', 0))).toBe(false);
  });

  it('runs every DAG FIX round, so the fix-loop diagnosis is actually read', async () => {
    expect(await phase2ImplementStep.shouldRun!(shouldRunCtx('dag', 1, [{ round: 1 }]))).toBe(true);
    expect(
      await phase2ImplementStep.shouldRun!(shouldRunCtx('dag', 4, [{ round: 2 }, { round: 4 }])),
    ).toBe(true);
  });

  it('still skips a DAG round the REVISE loop forked — no fix was requested for it', async () => {
    // Gate-1 spec reject routes back to 04 and bumps the round, so 06b/06c can first run at
    // round 2. `round > 0` read that as a fix round and ran a whole second implementation on
    // top of the DAG build (task ef954a3d: 06c took 3h35m, then this step started with a null
    // fixContext). No fix_loop.requested exists for the round, so it is not a fix round.
    expect(await phase2ImplementStep.shouldRun!(shouldRunCtx('dag', 2))).toBe(false);
  });

  it('skips when the only recorded request belongs to a DIFFERENT round', async () => {
    expect(await phase2ImplementStep.shouldRun!(shouldRunCtx('dag', 3, [{ round: 1 }]))).toBe(
      false,
    );
  });

  it('runs on a request whose diagnosis is empty — presence, not content', async () => {
    // loadFixLoopDiagnosis returns null for an empty diagnosis; reusing it as the gate would
    // read a real fix round as an original pass and skip the only step that fixes anything.
    expect(
      await phase2ImplementStep.shouldRun!(shouldRunCtx('dag', 1, [{ round: 1, diagnosis: '' }])),
    ).toBe(true);
  });

  it('runs in single mode at every round', async () => {
    expect(await phase2ImplementStep.shouldRun!(shouldRunCtx('single', 0))).toBe(true);
    expect(await phase2ImplementStep.shouldRun!(shouldRunCtx('single', 2))).toBe(true);
  });

  it('runs when 06b never produced a mode (legacy task)', async () => {
    expect(await phase2ImplementStep.shouldRun!(shouldRunCtx(null, 0))).toBe(true);
  });
});
