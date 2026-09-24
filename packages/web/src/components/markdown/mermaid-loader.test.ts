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
  it('adds its secured keys to mermaid own list rather than replacing it', async () => {
    const mermaid = (await import('mermaid')).default;
    mermaid.initialize(MERMAID_CONFIG);
    const secure = mermaid.mermaidAPI.getSiteConfig().secure ?? [];
    expect(secure).toEqual(expect.arrayContaining(['securityLevel', 'startOnLoad', 'maxTextSize']));
    expect(secure).toEqual(expect.arrayContaining(MERMAID_CONFIG.secure ?? []));
  });
});
