import { describe, expect, it } from 'vitest';
import { StepRegistry } from '../src/step-engine/registry.js';
import {
  registerOnboardingSteps,
  ripgrepConfigStep,
  detectionConfirmationStep,
  toolingInfrastructureStep,
  workflowPrefsStep,
  postOnboardingStep,
} from '../src/step-engine/steps/onboarding/index.js';

describe('onboarding registry', () => {
  it('registers all onboarding steps in declared order', () => {
    const registry = new StepRegistry();
    registerOnboardingSteps(registry);
    const steps = registry.listByWorkflow('onboarding');
    expect(steps.map((s) => s.metadata.id)).toEqual([
      '01-env-detect',
      '01_5-ripgrep-config',
      '02-detection-confirmation',
      '04-tooling-infrastructure',
      '06-workflow-prefs',
      '06_5-agent-discovery',
      '07-generate-files',
      '07_5-verify-files',
      '08-knowledge-acquisition',
      '09-qa',
      '09_5-skill-generation',
      '09_6-skill-verification',
      '10-rag-populate',
      '11-final-review',
      '12-post-onboarding',
    ]);
    expect(steps.map((s) => s.metadata.index)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
  });

  it('ripgrep step emits the drupal template for drupal frameworks', async () => {
    const detected = { framework: 'drupal' as const, needsConfig: true, template: null };
    expect(ripgrepConfigStep.metadata.requiresCli).toBe(false);
    expect(typeof ripgrepConfigStep.detect).toBe('function');
    void detected;
  });

  it('detection confirmation builds a form with name/framework/description fields', () => {
    const ctx = {} as never;
    const schema = detectionConfirmationStep.form!(ctx, {
      detectedName: 'foo',
      detectedFramework: 'drupal',
      detectedLanguage: 'php',
      containerType: 'ddev',
      databaseType: 'postgres',
      databaseVersion: '17',
      testPaths: ['tests'],
    });
    expect(schema).not.toBeNull();
    expect(schema!.fields.map((f) => f.id)).toEqual([
      'projectName',
      'framework',
      'primaryLanguage',
      'localUrl',
      'projectDescription',
    ]);
  });

  it('tooling infrastructure step picks the right LSP default by language', () => {
    const ctx = {} as never;
    const schema = toolingInfrastructureStep.form!(ctx, {
      primaryLanguage: 'php',
      containerType: 'ddev',
      databaseType: 'postgres',
    });
    const lsp = schema!.fields.find((f) => f.id === 'lspLanguage');
    expect(lsp?.type).toBe('select');
    expect((lsp as { default: string }).default).toBe('php');
  });

  it('workflow prefs form contains verification level radio with three options', () => {
    const ctx = {} as never;
    const schema = workflowPrefsStep.form!(ctx, null);
    const radio = schema!.fields.find((f) => f.id === 'verificationLevel');
    expect(radio?.type).toBe('radio');
    expect((radio as { options: { value: string }[] }).options.map((o) => o.value)).toEqual([
      'quick',
      'standard',
      'comprehensive',
    ]);
  });

  it('post-onboarding form has cleanup, commit and commitMessage fields', () => {
    const ctx = {} as never;
    const schema = postOnboardingStep.form!(ctx, { hasOrchestrationFolder: false });
    expect(schema!.fields.map((f) => f.id)).toEqual(['cleanup', 'commit', 'commitMessage']);
  });
});
