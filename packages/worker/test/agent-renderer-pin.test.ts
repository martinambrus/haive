import { describe, expect, it } from 'vitest';
import { AGENT_RENDERER_VERSION, CLI_PROVIDER_CATALOG, sha256Hex } from '@haive/shared';
import type { AgentSpec } from '@haive/shared';
import {
  RESPONSE_STYLE_EXEMPT_IDS,
  buildAgentFileForTarget,
  type AgentRenderTarget,
} from '../src/step-engine/steps/onboarding/_agent-templates.js';

// Pins the rendered agent body to AGENT_RENDERER_VERSION: a body change without a version bump fails here.

/** Append-only: one hash of the whole rendered corpus per renderer version. */
const RECORDED_RENDER_HASHES: Record<number, string> = {
  3: 'da45695aba92efcf413c6779b13bab2e55466fa4441fce442772f9cfe4802531',
  4: 'cc60435b284943bd72b2b7d2f94ea8769c746d02b20b19fa7c9f212be19d9a85',
};

const FULL: AgentSpec = {
  id: 'pin-full',
  title: 'Pin Full',
  description: 'Handles things: tricky #tag values with a "quote" and a back\\slash yes',
  color: 'blue',
  field: 'yes',
  tools: ['Read', 'Grep', 'Bash'],
  model: 'sonnet',
  expertise: 'senior',
  coreMission: 'Keep the pinned body honest.',
  responsibilities: ['First duty', 'Second duty', 'Third duty'],
  whenInvoked: ['When asked', 'When a diff lands'],
  executionSteps: [
    { title: 'Collect', body: 'Read the change.' },
    { title: 'Judge', body: 'Weigh the change.' },
  ],
  outputFormat: 'Report as """text""" with a summary.',
  qualityCriteria: ['Accurate', 'Brief'],
  antiPatterns: ['Guess', 'Skip checks'],
  kbReferences: {
    patterns: 'kb/patterns.md',
    standards: 'kb/standards.md',
    reference: 'kb/ref.md',
  },
  mcpTools: ['chrome-devtools', 'rag_search'],
};

const BARE: AgentSpec = {
  id: 'pin-bare',
  title: 'Pin Bare',
  description: 'does little',
  color: 'green',
  field: 'quality',
  tools: [],
  coreMission: 'Do little.',
  responsibilities: [],
  whenInvoked: [],
  executionSteps: [],
  outputFormat: '',
  qualityCriteria: [],
  antiPatterns: [],
};

const ONE_KB: AgentSpec = {
  ...BARE,
  id: 'pin-one-kb',
  kbReferences: { standards: 'kb/standards.md' },
};
const EMPTY_KB: AgentSpec = { ...BARE, id: 'pin-empty-kb', kbReferences: {} };
const BLANK_KB: AgentSpec = {
  ...BARE,
  id: 'pin-blank-kb',
  kbReferences: { patterns: '', standards: 'kb/standards.md', reference: '' },
};
const YAML_EDGE: AgentSpec = {
  ...BARE,
  id: 'pin-yaml-edge',
  description: '2001-12-14',
  field: 'null',
  kbReferences: { patterns: '~', standards: '1e3', reference: '- item' },
};
const YES_ID: AgentSpec = { ...BARE, id: 'yes' };
const PROSE: AgentSpec = {
  ...BARE,
  id: 'pin-prose',
  description:
    'API gateway reviewer (REST, gRPC) that checks routes, auth and rate limits, then reports findings with file and line references',
};
const MULTILINE: AgentSpec = {
  ...BARE,
  id: 'pin-multiline',
  description: 'Prüft Änderungen\nZeile zwei\tmit Tab',
};
const CONTROLS: AgentSpec = {
  ...BARE,
  id: 'pin-controls',
  description: 'Reads CR\r, U+0001\u0001, DEL\u007f, BS\u0008, a "quote" and a back\\slash',
};
const EXEMPT: AgentSpec[] = [...RESPONSE_STYLE_EXEMPT_IDS].sort().map((id) => ({ ...BARE, id }));
// Multi-line and control-character descriptions render as TOML escapes; a fixture edit moves the hash like a renderer change.
const SPECS: AgentSpec[] = [
  FULL,
  BARE,
  ONE_KB,
  EMPTY_KB,
  BLANK_KB,
  YAML_EDGE,
  YES_ID,
  PROSE,
  MULTILINE,
  CONTROLS,
  ...EXEMPT,
];

const DIRS: { dir: string; format: AgentRenderTarget['format'] }[] = [
  { dir: '.claude/agents', format: 'markdown' },
  { dir: '.gemini/agents', format: 'markdown' },
  { dir: '.codex/agents', format: 'toml' },
  { dir: '.agents/agents', format: 'markdown' },
  { dir: '.grok/agents', format: 'markdown' },
];
const LSP: (boolean | undefined)[] = [true, false, undefined];
const TARGETS: AgentRenderTarget[] = DIRS.flatMap(({ dir, format }) =>
  LSP.map((supportsLsp) =>
    supportsLsp === undefined ? { dir, format } : { dir, format, supportsLsp },
  ),
);

const tuples: [string, AgentRenderTarget, string][] = SPECS.flatMap((spec) =>
  TARGETS.map((target): [string, AgentRenderTarget, string] => [
    spec.id,
    target,
    buildAgentFileForTarget(spec, target),
  ]),
);
const render = (spec: AgentSpec, target: AgentRenderTarget) =>
  buildAgentFileForTarget(spec, target);
const claude = (supportsLsp?: boolean): AgentRenderTarget =>
  supportsLsp === undefined
    ? { dir: '.claude/agents', format: 'markdown' }
    : { dir: '.claude/agents', format: 'markdown', supportsLsp };
const frontmatterOf = (md: string) => md.split('\n---\n')[0]!.split('\n').slice(1);
const hasHeading = (text: string, heading: string) => text.split('\n').includes(heading);

describe('the rendered agent body is pinned to AGENT_RENDERER_VERSION', () => {
  it('matches the hash recorded for this renderer version', () => {
    const hash = sha256Hex(JSON.stringify(tuples));
    const recorded = RECORDED_RENDER_HASHES[AGENT_RENDERER_VERSION];
    const next = AGENT_RENDERER_VERSION + 1;
    const advice =
      recorded === undefined
        ? `AGENT_RENDERER_VERSION is ${AGENT_RENDERER_VERSION} but no hash is recorded for it: add \`${AGENT_RENDERER_VERSION}: '${hash}'\` to RECORDED_RENDER_HASHES in this file.`
        : `the rendered corpus changed since version ${AGENT_RENDERER_VERSION} was recorded. If the renderer changed, bump AGENT_RENDERER_VERSION to ${next} in packages/shared/src/templates/manifest.ts, add \`${next}: '${hash}'\` to RECORDED_RENDER_HASHES in this file and rebuild @haive/shared; never overwrite the entry for ${AGENT_RENDERER_VERSION} once a release holds it: installed custom-bundle agents were rendered from it. If only this file's fixtures changed the same applies after a release; while version ${AGENT_RENDERER_VERSION} is in no release, re-record its entry instead.`;
    expect(hash, advice).toBe(recorded);
  });

  it('records a hash for the current version as its newest entry', () => {
    const newest = Math.max(...Object.keys(RECORDED_RENDER_HASHES).map(Number));
    expect(newest).toBe(AGENT_RENDERER_VERSION);
  });
});

describe('the pinned corpus exercises every conditional block', () => {
  it('renders the Response Style block for every agent except the exempt ones', () => {
    expect(hasHeading(render(BARE, claude(true)), '## Response Style')).toBe(true);
    expect(EXEMPT.length).toBeGreaterThan(0);
    for (const spec of EXEMPT) {
      expect(hasHeading(render(spec, claude(true)), '## Response Style'), spec.id).toBe(false);
    }
  });

  it('renders a different Retrieval Protocol with and without LSP', () => {
    for (const [id, , output] of tuples) {
      expect(hasHeading(output, '## Retrieval Protocol'), id).toBe(true);
    }
    expect(render(FULL, claude(true))).not.toBe(render(FULL, claude(false)));
  });

  it('renders kb-references for one key, three keys and none', () => {
    const lines = (spec: AgentSpec) => frontmatterOf(render(spec, claude(true)));
    const kbCount = (spec: AgentSpec) => {
      const all = lines(spec);
      const at = all.indexOf('kb-references:');
      return at === -1 ? -1 : all.slice(at + 1).filter((l) => l.startsWith('  ')).length;
    };
    expect(kbCount(FULL)).toBe(3);
    expect(kbCount(ONE_KB)).toBe(1);
    expect(kbCount(BARE)).toBe(-1);
    expect(kbCount(EMPTY_KB)).toBe(-1);
    expect(kbCount(BLANK_KB)).toBe(1);
  });

  it('renders the model and expertise defaults and explicit values', () => {
    const bare = frontmatterOf(render(BARE, claude(true)));
    const full = frontmatterOf(render(FULL, claude(true)));
    expect(bare).toContain('model: opus');
    expect(bare).toContain('expertise: expert');
    expect(full).toContain('model: sonnet');
    expect(full).toContain('expertise: senior');
  });

  it('lists mcp-tools with rag_search once', () => {
    const line = (spec: AgentSpec) =>
      frontmatterOf(render(spec, claude(true))).find((l) => l.startsWith('mcp-tools:'));
    expect(line(BARE)).toBe('mcp-tools: [rag_search]');
    expect(line(FULL)).toBe('mcp-tools: [rag_search, chrome-devtools]');
  });

  it('quotes a frontmatter value a YAML parser would misread and leaves a plain one', () => {
    const full = frontmatterOf(render(FULL, claude(true)));
    const bare = frontmatterOf(render(BARE, claude(true)));
    expect(full.find((l) => l.startsWith('description: '))).toMatch(/^description: "/);
    expect(full).toContain('field: "yes"');
    expect(bare).toContain('description: does little');
    const edge = frontmatterOf(render(YAML_EDGE, claude(true)));
    expect(edge).toContain('description: "2001-12-14"');
    expect(edge).toContain('field: "null"');
  });

  it('quotes a bundle id and a multi-line description, and leaves long prose plain', () => {
    for (const target of [claude(true), { dir: '.gemini/agents', format: 'markdown' } as const]) {
      expect(frontmatterOf(render(YES_ID, target))).toContain('name: "yes"');
    }
    const descOf = (spec: AgentSpec) =>
      frontmatterOf(render(spec, claude(true))).filter((l) => l.startsWith('description:'));
    const prose = descOf(PROSE);
    expect(prose).toHaveLength(1);
    expect(prose[0]).not.toMatch(/^description: "/);
    const multi = descOf(MULTILINE);
    expect(multi).toHaveLength(1);
    expect(multi[0]).toMatch(/^description: ".*\\n.*"$/);
  });

  it('escapes a backslash, a double quote and a triple quote in TOML', () => {
    const toml = render(FULL, { dir: '.codex/agents', format: 'toml', supportsLsp: false });
    expect(toml).toContain('back\\\\slash');
    expect(toml).toContain('\\"quote\\"');
    expect(toml).toContain('\\"\\"\\"text\\"\\"\\"');
  });

  it('escapes newlines and control characters in TOML and keeps the sentence rule', () => {
    const toml = (spec: AgentSpec) =>
      render(spec, { dir: '.codex/agents', format: 'toml', supportsLsp: false });
    const multi = toml(MULTILINE);
    expect(multi).toContain('Zeile zwei\\tmit Tab');
    expect(multi).toContain('Prüft Änderungen\\nZeile zwei');
    const controls = toml(CONTROLS);
    for (const escape of ['\\r', '\\u0001', '\\u007F', '\\b']) {
      expect(controls).toContain(escape);
    }
    const claudeControls = frontmatterOf(render(CONTROLS, claude(true))).join('\n');
    expect(claudeControls).toContain('\\u007f');
    expect(claudeControls).not.toContain('\u007F');
    expect(render(PROSE, claude(true))).toContain('that API gateway reviewer');
    expect(render(BARE, claude(true))).toContain('that does little');
  });

  it('keeps two keys in the Gemini frontmatter', () => {
    const keys = frontmatterOf(render(FULL, { dir: '.gemini/agents', format: 'markdown' })).filter(
      (l) => /^[A-Za-z-]+:/.test(l),
    );
    expect(keys.map((l) => l.split(':')[0])).toEqual(['name', 'description']);
  });
});

describe('every catalog target renders in a shape the corpus pins', () => {
  const pinned = new Set(tuples.filter(([id]) => id === FULL.id).map(([, , output]) => output));
  for (const provider of Object.values(CLI_PROVIDER_CATALOG)) {
    if (provider.projectAgentsDir === null || provider.agentFileFormat === null) continue;
    const base = { dir: provider.projectAgentsDir, format: provider.agentFileFormat };
    const targets: AgentRenderTarget[] = [
      { ...base, supportsLsp: provider.supportsLsp },
      { ...base, supportsLsp: true },
      { ...base, supportsLsp: false },
      base,
    ];
    it(`pins the ${provider.name} rendering`, () => {
      for (const target of targets) {
        expect(
          pinned.has(render(FULL, target)),
          `catalog target ${provider.name} (${JSON.stringify(target)}) renders in a shape the corpus does not hold; add its serializer shape to the corpus`,
        ).toBe(true);
      }
    });
  }
});
