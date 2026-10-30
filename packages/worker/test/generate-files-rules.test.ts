import { describe, expect, it } from 'vitest';
import { buildCliRulesBlock, DEFAULT_AGENT_RULES } from '@haive/shared';
import {
  planRulesFiles,
  CLI_RULES_START,
  CLI_RULES_END,
} from '../src/step-engine/steps/onboarding/07-generate-files.js';

// {rulesFile, rulesFileMode} shapes mirroring the real adapters: claude-code/zai -> CLAUDE.md
// import, gemini -> GEMINI.md import, codex/amp/antigravity -> AGENTS.md native.
const claude = { rulesFile: 'CLAUDE.md', rulesFileMode: 'import' as const };
const gemini = { rulesFile: 'GEMINI.md', rulesFileMode: 'import' as const };
const codex = { rulesFile: 'AGENTS.md', rulesFileMode: 'native' as const };

describe('planRulesFiles', () => {
  it('puts the repository rules block in AGENTS.md and makes CLAUDE.md an @AGENTS.md import only', () => {
    const plan = planRulesFiles([claude], '- rule one\n- rule two');
    expect(plan.agentsRulesBlock).toContain(CLI_RULES_START);
    expect(plan.agentsRulesBlock).toContain(CLI_RULES_END);
    expect(plan.agentsRulesBlock).toContain('- rule one');
    expect(plan.importFiles).toEqual(['CLAUDE.md']);
    expect(plan.copyFiles).toEqual([]);
  });

  it('gives native CLIs no import file — they read AGENTS.md directly', () => {
    const plan = planRulesFiles([codex], '- rule');
    expect(plan.agentsRulesBlock).toContain('- rule');
    expect(plan.importFiles).toEqual([]);
    expect(plan.copyFiles).toEqual([]);
  });

  it('renders the block from the repository alone, whatever CLIs are enabled', () => {
    const one = planRulesFiles([claude], '- shared\n- a');
    const several = planRulesFiles([claude, codex, gemini], '- shared\n- a');
    expect(several.agentsRulesBlock).toBe(one.agentsRulesBlock);
    expect(one.agentsRulesBlock).toBe(buildCliRulesBlock(['- shared\n- a']));
    // codex is native; only the import-mode files point at AGENTS.md.
    expect(new Set(several.importFiles)).toEqual(new Set(['CLAUDE.md', 'GEMINI.md']));
  });

  it('follows the live default rules while the repository holds no override', () => {
    for (const none of [null, undefined]) {
      expect(planRulesFiles([claude], none).agentsRulesBlock).toBe(
        buildCliRulesBlock([DEFAULT_AGENT_RULES]),
      );
    }
  });

  it('returns a null rules block for an empty override, and still collects the import files', () => {
    for (const empty of ['', '   \n']) {
      const plan = planRulesFiles([claude], empty);
      expect(plan.agentsRulesBlock).toBeNull();
      expect(plan.importFiles).toEqual(['CLAUDE.md']);
    }
  });

  it('collects every distinct import file (CLAUDE.md + GEMINI.md)', () => {
    const plan = planRulesFiles([claude, gemini], '- r');
    expect(new Set(plan.importFiles)).toEqual(new Set(['CLAUDE.md', 'GEMINI.md']));
  });

  it('routes copy-mode files to copyFiles, not importFiles', () => {
    const plan = planRulesFiles([{ rulesFile: 'RULES.md', rulesFileMode: 'copy' }], '- r');
    expect(plan.copyFiles).toEqual(['RULES.md']);
    expect(plan.importFiles).toEqual([]);
  });
});
