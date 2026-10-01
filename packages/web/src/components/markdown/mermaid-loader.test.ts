import { describe, expect, it } from 'vitest';
import { MERMAID_CONFIG, refusesMermaidSource } from './mermaid-loader';

describe('refusesMermaidSource', () => {
  it('refuses syntax that reconfigures the renderer or names a resource', () => {
    expect(refusesMermaidSource('%%{init: {"theme": "forest"}}%%\nflowchart LR\n  A --> B')).toBe(
      true,
    );
    expect(refusesMermaidSource('flowchart LR\n  A["x %%{init: {}}%%"] --> B')).toBe(true);
    expect(
      refusesMermaidSource('---\nconfig:\n  theme: forest\n---\nflowchart LR\n  A --> B'),
    ).toBe(true);
    expect(refusesMermaidSource('flowchart LR\n  A@{ img: "https://x.example/i.png" }')).toBe(true);
    expect(
      refusesMermaidSource(
        'sequenceDiagram\n  participant A\n  properties A: {"icon": "https://x.example/i.png"}',
      ),
    ).toBe(true);
  });

  it('renders ordinary diagrams, a node named properties included', () => {
    expect(refusesMermaidSource('flowchart LR\n  A[Start] --> B{Ok?}\n  B -->|yes| C')).toBe(false);
    expect(refusesMermaidSource('flowchart LR\n  properties --> B')).toBe(false);
    expect(refusesMermaidSource('sequenceDiagram\n  A->>B: hi')).toBe(false);
  });
});

describe('MERMAID_CONFIG', () => {
  // The IMPORT is what takes the time here, not the assertions: this is the one test that loads
  // mermaid itself (~7 MB) rather than the loader's own module, and `packages/web` sets no
  // `testTimeout`, so it ran against vitest's 5 s default. MEASURED on 2026-10-01: this file alone
  // passes in well under a second and the whole web suite alone passes, while under `pnpm test`
  // across all eight workspace packages it was starved and died at 8,164 ms — taking CI red on a
  // branch that changed nothing in web. Bounded here rather than by a global bump, which would
  // hide a test that is slow for a real reason.
  it('adds its secured keys to mermaid own list rather than replacing it', async () => {
    const mermaid = (await import('mermaid')).default;
    mermaid.initialize(MERMAID_CONFIG);
    const secure = mermaid.mermaidAPI.getSiteConfig().secure ?? [];
    expect(secure).toEqual(expect.arrayContaining(['securityLevel', 'startOnLoad', 'maxTextSize']));
    expect(secure).toEqual(expect.arrayContaining(MERMAID_CONFIG.secure ?? []));
  }, 30_000);
});
