import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DetectResult, FrameworkName } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from './_helpers.js';

interface RipgrepDetect {
  framework: FrameworkName;
  needsConfig: boolean;
  template: string | null;
}

const TEMPLATES: Partial<Record<FrameworkName, string>> = {
  drupal: drupalTemplate(),
  drupal7: drupalTemplate(),
  laravel: laravelTemplate(),
  rails: railsTemplate(),
  nodejs: nodejsTemplate(),
  nextjs: nodejsTemplate(),
};

function drupalTemplate(): string {
  return [
    '# Ripgrep configuration for Drupal projects',
    '--type-add=drupal:*.module',
    '--type-add=drupal:*.inc',
    '--type-add=drupal:*.install',
    '--type-add=drupal:*.theme',
    '--type-add=drupal:*.profile',
    '--type-add=drupal:*.engine',
    '--type-add=drupal:*.php',
    '--type-add=php:*.module',
    '--type-add=php:*.inc',
    '--type-add=php:*.install',
    '--type-add=php:*.theme',
    '--type-add=php:*.profile',
    '--type-add=php:*.engine',
    '--smart-case',
    '',
  ].join('\n');
}

function laravelTemplate(): string {
  return [
    '# Ripgrep configuration for Laravel projects',
    '--type-add=blade:*.blade.php',
    '--type-add=php:*.blade.php',
    '--smart-case',
    '',
  ].join('\n');
}

function railsTemplate(): string {
  return [
    '# Ripgrep configuration for Rails projects',
    '--type-add=erb:*.erb',
    '--type-add=ruby:*.rake',
    '--type-add=ruby:*.gemspec',
    '--smart-case',
    '',
  ].join('\n');
}

function nodejsTemplate(): string {
  return [
    '# Ripgrep configuration for Node.js / React projects',
    '--type-add=js:*.mjs',
    '--type-add=js:*.cjs',
    '--type-add=js:*.jsx',
    '--type-add=ts:*.tsx',
    '--smart-case',
    '',
  ].join('\n');
}

interface EnvDetectShape {
  data: { project: { framework: FrameworkName } };
}

export const ripgrepConfigStep: StepDefinition<
  RipgrepDetect,
  { configWritten: boolean; path: string | null }
> = {
  metadata: {
    id: '01_5-ripgrep-config',
    workflowType: 'onboarding',
    index: 2,
    title: 'Ripgrep configuration',
    description:
      'Generates a project-local .ripgreprc file with framework-specific extensions when needed.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<RipgrepDetect> {
    const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-env-detect');
    const detected = (prev?.detect as DetectResult | null)?.data as
      | EnvDetectShape['data']
      | undefined;
    const framework = (detected?.project?.framework ?? 'general') as FrameworkName;
    const template = TEMPLATES[framework] ?? null;
    return { framework, needsConfig: template !== null, template };
  },

  async apply(ctx, args) {
    const detected = args.detected;
    if (!detected.needsConfig || !detected.template) {
      ctx.logger.info({ framework: detected.framework }, 'no ripgrep config needed');
      return { configWritten: false, path: null };
    }
    const target = path.join(ctx.repoPath, '.ripgreprc');
    await writeFile(target, detected.template, 'utf8');
    ctx.logger.info({ target, framework: detected.framework }, 'wrote .ripgreprc');
    return { configWritten: true, path: '.ripgreprc' };
  },
};
