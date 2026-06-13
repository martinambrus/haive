import { describe, expect, it } from 'vitest';
import {
  planRulesFiles,
  CLI_RULES_START,
  CLI_RULES_END,
} from '../src/step-engine/steps/onboarding/07-generate-files.js';

// Joined {rulesContent, rulesFile, rulesFileMode} shapes mirroring the real
// adapters: claude-code/zai -> CLAUDE.md import, gemini -> GEMINI.md import,
// codex/amp/antigravity -> AGENTS.md native.
const claude = (rules: string) => ({
  rulesContent: rules,
  rulesFile: 'CLAUDE.md',
  rulesFileMode: 'import' as const,
});
const gemini = (rules: string) => ({
  rulesContent: rules,
  rulesFile: 'GEMINI.md',
  rulesFileMode: 'import' as const,
});
const codex = (rules: string) => ({
  rulesContent: rules,
  rulesFile: 'AGENTS.md',
  rulesFileMode: 'native' as const,
});

describe('planRulesFiles', () => {
  it('puts the rules block in AGENTS.md and makes CLAUDE.md an @AGENTS.md import only', () => {
    const plan = planRulesFiles([claude('- rule one\n- rule two')]);
    expect(plan.agentsRulesBlock).toContain(CLI_RULES_START);
    expect(plan.agentsRulesBlock).toContain(CLI_RULES_END);
    expect(plan.agentsRulesBlock).toContain('- rule one');
    expect(plan.importFiles).toEqual(['CLAUDE.md']);
    expect(plan.copyFiles).toEqual([]);
  });

  it('gives native CLIs no import file — they read AGENTS.md directly', () => {
    const plan = planRulesFiles([codex('- rule')]);
    expect(plan.agentsRulesBlock).toContain('- rule');
    expect(plan.importFiles).toEqual([]);
    expect(plan.copyFiles).toEqual([]);
  });

  it('merges providers and dedups identical rule lines into one AGENTS.md block', () => {
    const plan = planRulesFiles([claude('- shared\n- a'), codex('- shared\n- b')]);
    const block = plan.agentsRulesBlock ?? '';
    expect(block.match(/- shared/g)).toHaveLength(1);
    expect(block).toContain('- a');
    expect(block).toContain('- b');
    // codex is native; only the import-mode claude file points at AGENTS.md.
    expect(plan.importFiles).toEqual(['CLAUDE.md']);
  });

  it('collects every distinct import file (CLAUDE.md + GEMINI.md)', () => {
    const plan = planRulesFiles([claude('- r'), gemini('- r')]);
    expect(new Set(plan.importFiles)).toEqual(new Set(['CLAUDE.md', 'GEMINI.md']));
  });

  it('returns a null rules block when no provider has rules content', () => {
    const plan = planRulesFiles([
      { rulesContent: '   ', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' },
    ]);
    expect(plan.agentsRulesBlock).toBeNull();
    expect(plan.importFiles).toEqual(['CLAUDE.md']);
  });

  it('routes copy-mode files to copyFiles, not importFiles', () => {
    const plan = planRulesFiles([
      { rulesContent: '- r', rulesFile: 'RULES.md', rulesFileMode: 'copy' },
    ]);
    expect(plan.copyFiles).toEqual(['RULES.md']);
    expect(plan.importFiles).toEqual([]);
  });
});
