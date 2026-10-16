import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Control of J6a (task #185): the export the build adds beside promptStepTools exists, and the audit of
// src/step-engine/steps/prompt-agent-paths.test.ts, which classifies every exported symbol whose name holds
// "prompt", names it. The audit itself runs unedited next to this file; it only fails once the export exists.
// Tags: [C5] is inside the brief, [C0] passes before and after.

const SRC = fileURLToPath(new URL('../src/', import.meta.url)).replace(/\/$/, '');
const PROMPT_STEP = 'step-engine/steps/custom/prompt-step.ts';
const AUDIT = 'step-engine/steps/prompt-agent-paths.test.ts';

const read = (rel: string): string => readFileSync(`${SRC}/${rel}`, 'utf8');
const exportsSymbol = (name: string): boolean =>
  new RegExp(`^export (?:async )?function ${name}\\s*\\(|^export const ${name}\\s*[=:]`, 'm').test(
    read(PROMPT_STEP),
  );
const auditNames = (symbol: string): boolean => read(AUDIT).includes(`'${PROMPT_STEP}#${symbol}'`);

describe('[C5] promptStepIntegrations and the prompt-agent-paths audit', () => {
  it('[C5] prompt-step.ts exports promptStepIntegrations, next to promptStepTools', () => {
    expect(exportsSymbol('promptStepTools'), 'promptStepTools is gone').toBe(true);
    expect(
      exportsSymbol('promptStepIntegrations'),
      `${PROMPT_STEP} does not export promptStepIntegrations`,
    ).toBe(true);
  });

  it('[C5] the audit names it, so a prompt-named export is never left unclassified', () => {
    expect(
      auditNames('promptStepIntegrations'),
      `${AUDIT} does not name ${PROMPT_STEP}#promptStepIntegrations`,
    ).toBe(true);
  });

  it('[C0] the audit still names the symbols it named before', () => {
    for (const symbol of ['promptStepTools', 'promptStepNamedText', 'buildPromptStep']) {
      expect(auditNames(symbol), `${AUDIT} lost ${symbol}`).toBe(true);
    }
  });
});
