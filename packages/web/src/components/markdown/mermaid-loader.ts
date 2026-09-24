import type { MermaidConfig } from 'mermaid';

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

/** SVG-text labels that can hold no element loading a resource. `secure` joins mermaid's own list,
 *  and those keys are stripped from every directive and frontmatter block at any depth. */
export const MERMAID_CONFIG: MermaidConfig = {
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'strict',
  htmlLabels: false,
  flowchart: { htmlLabels: false },
  dompurifyConfig: {
    FORBID_TAGS: [
      'img',
      'image',
      'feimage',
      'picture',
      'source',
      'video',
      'audio',
      'track',
      'iframe',
      'object',
      'embed',
      'link',
      'style',
      'input',
    ],
    FORBID_ATTR: ['style', 'src', 'srcset', 'href', 'xlink:href', 'background', 'poster'],
  },
  secure: [
    'htmlLabels',
    'themeCSS',
    'fontFamily',
    'themeVariables',
    'altFontFamily',
    'dompurifyConfig',
  ],
};

function loadMermaid() {
  mermaidPromise ??= import('mermaid').then((m) => {
    m.default.initialize(MERMAID_CONFIG);
    return m.default;
  });
  return mermaidPromise;
}

/** Syntax that reconfigures the renderer or names a resource for it to load. None of the diagrams
 *  stored on this install uses any of it, so a source that does is shown as code instead. */
const REFUSED_SYNTAX = [/%%\{/, /^\s*---/, /@\{/, /^\s*properties\s+[^\n:]+:/m];

export function refusesMermaidSource(source: string): boolean {
  return REFUSED_SYNTAX.some((re) => re.test(source));
}

/** The SVG for `source`, or null when it is refused, fails to parse or fails to render. Never call
 *  the render result's `bindFunctions`: its tooltips are sanitised with mermaid's default profile. */
export async function renderMermaid(id: string, source: string): Promise<string | null> {
  if (refusesMermaidSource(source)) return null;
  try {
    const mermaid = await loadMermaid();
    await mermaid.parse(source);
    return (await mermaid.render(id, source)).svg;
  } catch {
    return null;
  }
}
