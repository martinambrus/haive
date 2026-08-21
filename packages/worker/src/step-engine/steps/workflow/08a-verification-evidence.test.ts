import { describe, it, expect, vi } from 'vitest';

const buildScreenshotManifest = vi.fn();
vi.mock('./_screenshot-gallery.js', () => ({
  buildScreenshotManifest: (...a: unknown[]) => buildScreenshotManifest(...a),
}));

/** F7: a browser-verification step must not report a credible PASS when it produced no
 *  evidence it ever drove a browser.
 *
 *  MEASURED on task de2b313d: method=mcp, passed=true, screenshots=0, with the tester's
 *  own notes reading "Chrome DevTools MCP server never connected during this session —
 *  no browser-based testing was possible ... All testing was performed via static code
 *  analysis". Gate 2 then showed a green browser row AND treated it as the authoritative
 *  runtime signal, which demotes a failed HTTP smoke to advisory.
 *
 *  The rule under test is deliberately structural: evidence is a screenshot manifest
 *  built from files that exist ON DISK. It is never the tester's notes text, which is
 *  model prose and will drift. */
describe('F7 — verificationIncomplete rule', () => {
  /** The predicate as applied in applyMcp's tester path. */
  const isIncomplete = (passed: boolean, artifactPath: string | null): boolean =>
    passed && artifactPath === null;

  it('flags a reported pass that captured nothing', () => {
    expect(isIncomplete(true, null)).toBe(true);
  });

  it('does not flag a pass backed by a real manifest', () => {
    expect(isIncomplete(true, '/haive/workdir/.haive/screenshots/manifest.json')).toBe(false);
  });

  it('does not flag a FAIL that captured nothing', () => {
    // A failing test with no screenshots is just a failure — it already blocks, and
    // marking it "incomplete" as well would muddy why the gate is unhappy.
    expect(isIncomplete(false, null)).toBe(false);
  });
});

/** The gate-2 consumption rules, mirrored from 09-gate-2-verify-approval. */
describe('F7 — gate 2 treats an evidence-free pass as not clean', () => {
  type B = {
    passed: boolean;
    skipped: boolean;
    method: string;
    verificationIncomplete: boolean;
  };
  const browserOk = (b: B | null): boolean => b === null || (b.passed && !b.verificationIncomplete);
  const authoritative = (b: B | null): boolean =>
    b !== null &&
    !b.skipped &&
    b.passed &&
    !b.verificationIncomplete &&
    (b.method === 'mcp' || b.method === 'interactive');

  const evidenceFree: B = {
    passed: true,
    skipped: false,
    method: 'mcp',
    verificationIncomplete: true,
  };
  const real: B = { passed: true, skipped: false, method: 'mcp', verificationIncomplete: false };

  it('does not default the gate to approve on an evidence-free pass', () => {
    expect(browserOk(evidenceFree)).toBe(false);
    expect(browserOk(real)).toBe(true);
  });

  it('refuses to let an evidence-free pass outrank the HTTP smoke', () => {
    // This is the dangerous half: `smokeAdvisory = smokeFailed && browserRuntimeAuthoritative`,
    // so a phantom browser pass would silently demote a REAL failed smoke to advisory.
    expect(authoritative(evidenceFree)).toBe(false);
    expect(authoritative(real)).toBe(true);
  });

  it('leaves a step that never ran alone', () => {
    expect(browserOk(null)).toBe(true);
    expect(authoritative(null)).toBe(false);
  });

  it('treats a row written before the flag existed as complete', () => {
    // `verificationIncomplete` is optional on the output; gate 2 reads `=== true`, so an
    // absent value must not retroactively mark old passes as suspect.
    const legacy = { passed: true, skipped: false, method: 'mcp' } as B;
    expect(browserOk({ ...legacy, verificationIncomplete: undefined as unknown as boolean })).toBe(
      true,
    );
  });
});
