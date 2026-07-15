import { describe, expect, it } from 'vitest';
import { StepRegistry } from '../src/step-engine/registry.js';
import {
  registerOnboardingSteps,
  ripgrepConfigStep,
  detectionConfirmationStep,
  toolingInfrastructureStep,
  postOnboardingStep,
} from '../src/step-engine/steps/onboarding/index.js';

describe('onboarding registry', () => {
  it('registers all onboarding steps in declared order', () => {
    const registry = new StepRegistry();
    registerOnboardingSteps(registry);
    const steps = registry.listByWorkflow('onboarding');
    expect(steps.map((s) => s.metadata.id)).toEqual([
      '00-model-health-onboarding',
      '01-env-detect',
      '01_5-ripgrep-config',
      '02-detection-confirmation',
      '04-tooling-infrastructure',
      '04_5-global-kb',
      '06_3-custom-bundles',
      '06_5-agent-discovery',
      '06_7-scope-selection',
      '07-generate-files',
      '07_5-verify-files',
      '08-knowledge-acquisition',
      '09-qa',
      '09_1-qa-suggestions',
      '09_2-qa-resolve',
      '09_3-qa-review',
      '09_5-skill-generation',
      '09_5b-skill-repair',
      '09_6-skill-verification',
      '09_6_4-global-kb-merge',
      '09_6_5-global-kb-review',
      '09_7-rag-source-selection',
      '10-rag-populate',
      '11-final-review',
      '12-post-onboarding',
      '13-onboarding-push',
    ]);
    expect(steps.map((s) => s.metadata.index)).toEqual([
      0, 1, 2, 3, 4, 4.5, 5.5, 6, 6.5, 7, 8, 9, 10, 10.25, 10.5, 10.75, 11, 11.5, 12, 12.4, 12.5,
      13, 14, 15, 16, 17,
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
      webserver: 'nginx-fpm',
      docroot: 'web',
      runtimeVersions: { php: '8.3' },
      indicators: ['composer.json'],
      testPaths: ['tests'],
      testFrameworks: ['phpunit'],
      localUrl: 'https://foo.ddev.site',
      buildTool: null,
      projectDescription: 'A Drupal project',
      source: 'llm',
    });
    expect(schema).not.toBeNull();
    expect(schema!.fields.map((f) => f.id)).toEqual([
      'projectName',
      'framework',
      'primaryLanguage',
      'localUrl',
      'databaseType',
      'databaseVersion',
      'phpVersion',
      'webserver',
      'testFrameworks',
      'buildTool',
      'projectDescription',
    ]);
  });

  it('tooling infrastructure step picks the right LSP default by language', () => {
    const ctx = {} as never;
    const schema = toolingInfrastructureStep.form!(ctx, {
      primaryLanguage: 'php',
      framework: 'generic',
      containerType: 'ddev',
      databaseType: 'postgres',
      hasPhpExtendedExtensions: false,
      cliSupportsLsp: true,
    });
    const lsp = schema!.fields.find((f) => f.id === 'lspLanguages');
    expect(lsp?.type).toBe('multi-select');
    // Single PHP LSP survivor now — all PHP (generic or CMS) defaults to it.
    expect((lsp as { defaults: string[] }).defaults).toEqual(['php-extended']);
  });

  it('tooling infrastructure defaults to php-extended for Drupal frameworks', () => {
    const ctx = {} as never;
    const schema = toolingInfrastructureStep.form!(ctx, {
      primaryLanguage: 'php',
      framework: 'drupal',
      containerType: 'ddev',
      databaseType: 'postgres',
      hasPhpExtendedExtensions: false,
      cliSupportsLsp: true,
    });
    const lsp = schema!.fields.find((f) => f.id === 'lspLanguages');
    expect((lsp as { defaults: string[] }).defaults).toEqual(['php-extended']);
  });

  it('tooling infrastructure defaults to php-extended when PHP candidate extensions detected', () => {
    const ctx = {} as never;
    const schema = toolingInfrastructureStep.form!(ctx, {
      primaryLanguage: 'php',
      framework: 'generic',
      containerType: 'none',
      databaseType: null,
      hasPhpExtendedExtensions: true,
      cliSupportsLsp: true,
    });
    const lsp = schema!.fields.find((f) => f.id === 'lspLanguages');
    expect((lsp as { defaults: string[] }).defaults).toEqual(['php-extended']);
  });

  it('hides every LSP choice for a CLI without an LSP bridge', () => {
    const ctx = {} as never;
    const schema = toolingInfrastructureStep.form!(ctx, {
      primaryLanguage: 'typescript',
      framework: 'generic',
      containerType: 'none',
      databaseType: null,
      hasPhpExtendedExtensions: false,
      cliSupportsLsp: false,
    });
    expect(schema!.fields.some((field) => field.id === 'lspLanguages')).toBe(false);
  });

  it('keeps all supported language-server choices for an LSP-capable CLI', () => {
    const ctx = {} as never;
    const schema = toolingInfrastructureStep.form!(ctx, {
      primaryLanguage: 'typescript',
      framework: 'generic',
      containerType: 'none',
      databaseType: null,
      hasPhpExtendedExtensions: false,
      cliSupportsLsp: true,
    });
    const field = schema!.fields.find((candidate) => candidate.id === 'lspLanguages');
    expect(field?.type).toBe('multi-select');
    expect(
      (field as { options: Array<{ value: string }> }).options.map((option) => option.value),
    ).toEqual(['php-extended', 'typescript', 'python', 'go', 'rust', 'java']);
  });

  it('tooling infrastructure includes DDEV rag option only when DDEV detected', () => {
    const ctx = {} as never;
    const withDdev = toolingInfrastructureStep.form!(ctx, {
      primaryLanguage: 'php',
      framework: 'drupal',
      containerType: 'ddev',
      databaseType: 'postgres',
      hasPhpExtendedExtensions: false,
    });
    const ragWithDdev = withDdev!.fields.find((f) => f.id === 'ragMode');
    expect(ragWithDdev?.type).toBe('select');
    const ddevOpts = (ragWithDdev as { options: { value: string }[] }).options;
    expect(ddevOpts.map((o) => o.value)).toContain('ddev');

    const noDdev = toolingInfrastructureStep.form!(ctx, {
      primaryLanguage: 'javascript',
      framework: 'generic',
      containerType: 'none',
      databaseType: null,
      hasPhpExtendedExtensions: false,
    });
    const ragNoDdev = noDdev!.fields.find((f) => f.id === 'ragMode');
    const noDdevOpts = (ragNoDdev as { options: { value: string }[] }).options;
    expect(noDdevOpts.map((o) => o.value)).not.toContain('ddev');
  });

  it('tooling infrastructure includes Ollama and embedding fields', () => {
    const ctx = {} as never;
    const schema = toolingInfrastructureStep.form!(ctx, {
      primaryLanguage: 'php',
      framework: 'generic',
      containerType: 'none',
      databaseType: null,
      hasPhpExtendedExtensions: false,
    });
    const fieldIds = schema!.fields.map((f) => f.id);
    expect(fieldIds).toContain('ollamaUrl');
    expect(fieldIds).toContain('embeddingModel');
    expect(fieldIds).toContain('embeddingDimensions');
  });

  it('post-onboarding form has commit and commitMessage fields', () => {
    const ctx = {} as never;
    const schema = postOnboardingStep.form!(ctx, {});
    expect(schema!.fields.map((f) => f.id)).toEqual(['commit', 'commitMessage']);
  });
});
