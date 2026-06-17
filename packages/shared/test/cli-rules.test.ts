import { describe, it, expect } from 'vitest';
import {
  CLI_RULES_START,
  CLI_RULES_END,
  dedupLines,
  buildCliRulesBlock,
  buildCliRulesBlockFromProviders,
  resolveEffectiveRules,
  extractRegion,
  upsertRegion,
} from '../src/templates/cli-rules.js';
import { normalizeContent, sha256Hex } from '../src/templates/manifest.js';
import { DEFAULT_AGENT_RULES } from '../src/constants/default-agent-rules.js';

const PI_START = '<!-- haive:project-info -->';
const PI_END = '<!-- /haive:project-info -->';

// A representative AGENTS.md with a project-info region and trailing user text,
// but no cli-rules region yet.
const HOST_NO_RULES = `# AGENTS.md

${PI_START}
name: demo
${PI_END}

User-owned notes below.
`;

const hash = (s: string) => sha256Hex(normalizeContent(s));

describe('dedupLines', () => {
  it('dedupes on trimmed content, first occurrence wins', () => {
    const out = dedupLines(['- a\n- b', '  - a  \n- c']);
    expect(out).toBe('- a\n- b\n- c\n');
  });
});

describe('buildCliRulesBlock', () => {
  it('returns null when no provider has non-empty rules', () => {
    expect(buildCliRulesBlock([])).toBeNull();
    expect(buildCliRulesBlock(['', '   ', '\n'])).toBeNull();
  });

  it('wraps the deduped merge in the cli-rules markers', () => {
    const block = buildCliRulesBlock(['- a\n- b', '- b\n- c']);
    expect(block).toBe(`${CLI_RULES_START}\n- a\n- b\n- c\n${CLI_RULES_END}\n`);
  });

  it('is order-sensitive across differing provider rules (caller must sort)', () => {
    const ab = buildCliRulesBlock(['- a', '- b']);
    const ba = buildCliRulesBlock(['- b', '- a']);
    expect(ab).not.toBe(ba);
  });
});

describe('resolveEffectiveRules', () => {
  it('inherits the live default when rules are empty or whitespace', () => {
    expect(resolveEffectiveRules('')).toBe(DEFAULT_AGENT_RULES);
    expect(resolveEffectiveRules('   \n\t')).toBe(DEFAULT_AGENT_RULES);
  });

  it('inherits the live default for a verbatim copy of a shipped default', () => {
    // DEFAULT_AGENT_RULES's own hash is in KNOWN_DEFAULT_RULES_HASHES.
    expect(resolveEffectiveRules(DEFAULT_AGENT_RULES)).toBe(DEFAULT_AGENT_RULES);
  });

  it('keeps an explicit override as-is', () => {
    expect(resolveEffectiveRules('- my custom rule')).toBe('- my custom rule');
  });
});

describe('buildCliRulesBlockFromProviders', () => {
  const p = (name: string, rulesContent: string, enabled = true) => ({
    name,
    rulesContent,
    enabled,
  });

  it('an enabled provider with empty rules inherits the template', () => {
    expect(buildCliRulesBlockFromProviders([p('codex', '')])).toBe(
      buildCliRulesBlock([DEFAULT_AGENT_RULES]),
    );
  });

  it('excludes disabled providers; merges overrides with inherited defaults', () => {
    const block = buildCliRulesBlockFromProviders([
      p('claude-code', '- override'),
      p('codex', '- ignored', false),
      p('gemini', ''),
    ]);
    expect(block).toBe(buildCliRulesBlock(['- override', DEFAULT_AGENT_RULES]));
  });

  it('is deterministic regardless of provider row order (sorted by name)', () => {
    const forward = buildCliRulesBlockFromProviders([p('claude-code', '- a'), p('codex', '- b')]);
    const reversed = buildCliRulesBlockFromProviders([p('codex', '- b'), p('claude-code', '- a')]);
    expect(forward).toBe(reversed);
    // drift hash is taken over this block, so equal block => no false drift.
    expect(hash(forward!)).toBe(hash(reversed!));
  });

  it('returns null only when every provider is disabled', () => {
    expect(
      buildCliRulesBlockFromProviders([p('claude-code', '- a', false), p('codex', '', false)]),
    ).toBeNull();
  });
});

describe('extractRegion', () => {
  it('returns the marker-inclusive span', () => {
    const block = buildCliRulesBlock(['- a'])!;
    const file = upsertRegion(HOST_NO_RULES, block, CLI_RULES_START, CLI_RULES_END);
    const span = extractRegion(file, CLI_RULES_START, CLI_RULES_END);
    expect(span).not.toBeNull();
    expect(span!.startsWith(CLI_RULES_START)).toBe(true);
    expect(span!.endsWith(CLI_RULES_END)).toBe(true);
  });

  it('returns null when markers are absent', () => {
    expect(extractRegion(HOST_NO_RULES, CLI_RULES_START, CLI_RULES_END)).toBeNull();
  });
});

describe('upsertRegion + round-trip hash invariant', () => {
  it('appends when markers absent, and the written region re-extracts to the same hash', () => {
    const block = buildCliRulesBlock(['- a\n- b'])!;
    const written = upsertRegion(HOST_NO_RULES, block, CLI_RULES_START, CLI_RULES_END);
    const extracted = extractRegion(written, CLI_RULES_START, CLI_RULES_END)!;
    // The drift comparison hashes normalizeContent(block) vs normalizeContent(disk region).
    expect(hash(extracted)).toBe(hash(block));
  });

  it('replaces the region in place on re-apply and leaves other regions intact', () => {
    const v1 = upsertRegion(
      HOST_NO_RULES,
      buildCliRulesBlock(['- a'])!,
      CLI_RULES_START,
      CLI_RULES_END,
    );
    const newBlock = buildCliRulesBlock(['- a\n- b\n- c'])!;
    const v2 = upsertRegion(v1, newBlock, CLI_RULES_START, CLI_RULES_END);
    // cli-rules region updated...
    expect(hash(extractRegion(v2, CLI_RULES_START, CLI_RULES_END)!)).toBe(hash(newBlock));
    // ...project-info region and user text untouched, no duplicated cli-rules markers.
    expect(extractRegion(v2, PI_START, PI_END)).toBe(`${PI_START}\nname: demo\n${PI_END}`);
    expect(v2).toContain('User-owned notes below.');
    expect(v2.match(new RegExp(CLI_RULES_START, 'g'))!.length).toBe(1);
  });

  it('removes the region (markers and all) when given an empty block', () => {
    const v1 = upsertRegion(
      HOST_NO_RULES,
      buildCliRulesBlock(['- a'])!,
      CLI_RULES_START,
      CLI_RULES_END,
    );
    const removed = upsertRegion(v1, '', CLI_RULES_START, CLI_RULES_END);
    expect(extractRegion(removed, CLI_RULES_START, CLI_RULES_END)).toBeNull();
    expect(removed).not.toContain(CLI_RULES_START);
    // project-info survives the removal.
    expect(extractRegion(removed, PI_START, PI_END)).toBe(`${PI_START}\nname: demo\n${PI_END}`);
  });
});
