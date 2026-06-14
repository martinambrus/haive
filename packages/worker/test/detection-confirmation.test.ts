import { describe, expect, it } from 'vitest';
import { logger } from '@haive/shared';
import { detectionConfirmationStep } from '../src/step-engine/steps/onboarding/02-detection-confirmation.js';
import type { StepContext } from '../src/step-engine/step-definition.js';

type Detected = Parameters<NonNullable<typeof detectionConfirmationStep.form>>[1];

const ctx = { logger: logger.child({ test: 'confirm' }) } as unknown as StepContext;

function det(over: Partial<Detected>): Detected {
  return {
    detectedName: 'x',
    detectedFramework: 'general',
    detectedLanguage: 'unknown',
    containerType: 'none',
    databaseType: null,
    databaseVersion: null,
    webserver: null,
    docroot: null,
    runtimeVersions: {},
    indicators: [],
    testPaths: [],
    testFrameworks: [],
    localUrl: null,
    buildTool: null,
    projectDescription: null,
    source: 'deterministic',
    ...over,
  } as Detected;
}

function fieldIds(detected: Detected): string[] {
  return detectionConfirmationStep.form!(ctx, detected, undefined).fields.map((f) => f.id);
}

describe('02 detection-confirmation conditional fields', () => {
  it('shows Node version but not PHP for a Node project', () => {
    const ids = fieldIds(
      det({
        detectedFramework: 'nextjs',
        detectedLanguage: 'javascript',
        indicators: ['package.json'],
      }),
    );
    expect(ids).toContain('nodeVersion');
    expect(ids).not.toContain('phpVersion');
  });

  it('shows PHP version but not Node for a Drupal project', () => {
    const ids = fieldIds(
      det({ detectedFramework: 'drupal', detectedLanguage: 'php', indicators: ['composer.json'] }),
    );
    expect(ids).toContain('phpVersion');
    expect(ids).not.toContain('nodeVersion');
  });

  it('shows both for a mixed Drupal + Node repo', () => {
    const ids = fieldIds(
      det({
        detectedFramework: 'drupal',
        detectedLanguage: 'php',
        indicators: ['composer.json', 'package.json'],
      }),
    );
    expect(ids).toContain('phpVersion');
    expect(ids).toContain('nodeVersion');
  });

  it('shows the Rust version field for a Rust project only', () => {
    const ids = fieldIds(
      det({ detectedFramework: 'rust', detectedLanguage: 'rust', indicators: ['Cargo.toml'] }),
    );
    expect(ids).toContain('rustVersion');
    expect(ids).not.toContain('phpVersion');
    expect(ids).not.toContain('nodeVersion');
  });

  it('shows the Go version field for a Go project only', () => {
    const ids = fieldIds(
      det({ detectedFramework: 'go', detectedLanguage: 'go', indicators: ['go.mod'] }),
    );
    expect(ids).toContain('goVersion');
    expect(ids).not.toContain('phpVersion');
  });

  it('always keeps the universal fields', () => {
    const ids = fieldIds(det({}));
    expect(ids).toEqual(
      expect.arrayContaining(['projectName', 'framework', 'primaryLanguage', 'databaseType']),
    );
  });
});
