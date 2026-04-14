import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import type { DetectResult } from '@haive/shared';
import { logger } from '@haive/shared';
import { envDetectStep } from '../src/step-engine/steps/onboarding/01-env-detect.js';
import type { StepContext } from '../src/step-engine/step-definition.js';

interface EnvDetectData {
  project: { name: string; framework: string; primaryLanguage: string };
  container: {
    type: string;
    configFile: string | null;
    projectName: string | null;
    databaseType: string | null;
    databaseVersion: string | null;
    runtimeVersions: Record<string, string>;
  };
  stack: {
    language: string | null;
    framework: string;
    indicators: string[];
    runtimeVersions: Record<string, string>;
  };
  paths: {
    testPaths: string[];
    envFiles: string[];
    customCodePaths: { include: readonly string[]; exclude: readonly string[] };
  };
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'haive-envdetect-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function fakeCtx(repoPath: string): StepContext {
  return {
    taskId: 'task-1',
    taskStepId: 'step-1',
    userId: 'user-1',
    repoPath,
    workspacePath: repoPath,
    cliProviderId: null,
    db: undefined as never,
    logger: logger.child({ test: 'env-detect' }),
  };
}

async function runDetect(repoPath: string): Promise<EnvDetectData> {
  const result = (await envDetectStep.detect!(fakeCtx(repoPath))) as DetectResult;
  return result.data as unknown as EnvDetectData;
}

describe('envDetectStep', () => {
  it('detects a Next.js project from package.json', async () => {
    await writeFile(
      path.join(tmpRoot, 'package.json'),
      JSON.stringify({
        name: 'my-next-app',
        dependencies: { next: '^16.0.0', react: '^19.0.0' },
      }),
    );
    await mkdir(path.join(tmpRoot, '__tests__'));

    const data = await runDetect(tmpRoot);
    expect(data.project.framework).toBe('nextjs');
    expect(data.project.primaryLanguage).toBe('javascript');
    expect(data.stack.indicators).toContain('package.json');
    expect(data.paths.testPaths).toContain('__tests__');
  });

  it('detects Drupal 7 from composer.json + bootstrap.inc', async () => {
    await writeFile(
      path.join(tmpRoot, 'composer.json'),
      JSON.stringify({
        name: 'my-drupal',
        require: { 'drupal/core': '~7' },
      }),
    );
    await mkdir(path.join(tmpRoot, 'includes'));
    await writeFile(path.join(tmpRoot, 'includes', 'bootstrap.inc'), '<?php');
    await mkdir(path.join(tmpRoot, '.ddev'));
    await writeFile(
      path.join(tmpRoot, '.ddev', 'config.yaml'),
      [
        'name: my-drupal',
        'type: drupal7',
        'docroot: web',
        'php_version: "8.1"',
        'database:',
        '  type: postgres',
        '  version: "17"',
        'webserver_type: nginx-fpm',
      ].join('\n'),
    );

    const data = await runDetect(tmpRoot);
    expect(data.project.framework).toBe('drupal7');
    expect(data.project.primaryLanguage).toBe('php');
    expect(data.container.type).toBe('ddev');
    expect(data.container.projectName).toBe('my-drupal');
    expect(data.container.databaseType).toBe('postgres');
    expect(data.container.databaseVersion).toBe('17');
    expect(data.container.runtimeVersions.php).toBe('8.1');
  });

  it('detects docker-compose with mariadb', async () => {
    await writeFile(
      path.join(tmpRoot, 'docker-compose.yml'),
      [
        'version: "3.9"',
        'services:',
        '  app:',
        '    image: php:8.2',
        '  db:',
        '    image: mariadb:11',
        '  cache:',
        '    image: redis:7',
      ].join('\n'),
    );
    await writeFile(path.join(tmpRoot, 'composer.json'), JSON.stringify({}));

    const data = await runDetect(tmpRoot);
    expect(data.container.type).toBe('docker-compose');
    expect(data.container.databaseType).toBe('mariadb');
    expect(data.container.configFile).toBe('docker-compose.yml');
    expect(data.project.primaryLanguage).toBe('php');
  });

  it('detects Django from manage.py', async () => {
    await writeFile(path.join(tmpRoot, 'manage.py'), '#!/usr/bin/env python');
    await writeFile(path.join(tmpRoot, 'pyproject.toml'), '[project]\nname="x"');
    await writeFile(path.join(tmpRoot, '.env'), 'TEST=1\n');

    const data = await runDetect(tmpRoot);
    expect(data.project.framework).toBe('django');
    expect(data.project.primaryLanguage).toBe('python');
    expect(data.paths.envFiles).toContain('.env');
  });

  it('falls back to general framework on empty repo and warns', async () => {
    const result = (await envDetectStep.detect!(fakeCtx(tmpRoot))) as DetectResult;
    const data = result.data as unknown as EnvDetectData;
    expect(data.project.framework).toBe('general');
    expect(data.project.primaryLanguage).toBe('unknown');
    expect(result.warnings).toContain('no language indicators detected');
  });

  it('apply creates .claude and knowledge_base directories', async () => {
    const result = (await envDetectStep.apply(fakeCtx(tmpRoot), {
      detected: { summary: '', data: {}, warnings: [] } as DetectResult,
      formValues: {},
    })) as { directoriesCreated: string[] };
    expect(result.directoriesCreated).toEqual(['.claude', '.claude/knowledge_base']);
    const { stat } = await import('node:fs/promises');
    const claudeStat = await stat(path.join(tmpRoot, '.claude', 'knowledge_base'));
    expect(claudeStat.isDirectory()).toBe(true);
  });
});
