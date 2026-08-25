/** Module-level singleton so mermaid (a ~1.5MB chunk) loads once, lazily, and
 *  only on pages that actually render a diagram. The dynamic import keeps it out
 *  of the server bundle and the initial client chunk.
 *
 *  Extracted from mermaid-block so the plan graph can share the same instance:
 *  two copies would mean two 1.5MB chunks and two `initialize` calls racing over
 *  the same global config.
 *
 *  `securityLevel: 'strict'` is not negotiable here — every diagram this app
 *  renders is authored by an LLM or by a user, so 'loose' would let a label
 *  execute script. */
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;

export function loadMermaid() {
  mermaidPromise ??= import('mermaid').then((m) => {
    m.default.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
    return m.default;
  });
  return mermaidPromise;
}
