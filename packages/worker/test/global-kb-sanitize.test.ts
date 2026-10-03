import { describe, expect, it } from 'vitest';
import { sanitizeGlobalArticle } from '../src/step-engine/steps/_global-kb-promote.js';

describe('sanitizeGlobalArticle', () => {
  // The real leak observed in haive_kb_global: a re-routed Vitest quick-reference
  // promoted verbatim with the project name in the title/body + a source footer.
  it('genericizes the original Siteray leak (title, namespace, source footer)', () => {
    const body = [
      '# Vitest Quick Reference for Siteray',
      '',
      '## Cheat Sheet',
      '',
      '```ts',
      "vi.mock('@siteray/database', () => ({}));",
      'npx pnpm --filter @siteray/worker test',
      '```',
      '',
      '## Source files',
      '',
      '- `packages/api/tests/auth.core.integration.test.ts`',
      '',
    ].join('\n');
    const out = sanitizeGlobalArticle({
      title: 'Vitest Quick Reference for Siteray',
      body,
      projectName: 'siteray',
    });
    expect(out.title).toBe('Vitest Quick Reference');
    expect(out.body).not.toMatch(/siteray/i);
    expect(out.body).not.toMatch(/source files/i);
    expect(out.body).not.toMatch(/packages\/api\/tests/);
    expect(out.body).toContain('@example-app/database');
    expect(out.body).toContain('# Vitest Quick Reference for example-app');
  });

  it('drops an "in <name>" title connector', () => {
    expect(
      sanitizeGlobalArticle({
        title: 'Vitest Best Practices in Siteray',
        body: '',
        projectName: 'siteray',
      }).title,
    ).toBe('Vitest Best Practices');
  });

  it('removes a leading project name from the title', () => {
    expect(
      sanitizeGlobalArticle({
        title: 'Siteray Coding Standards',
        body: '',
        projectName: 'Siteray',
      }).title,
    ).toBe('Coding Standards');
  });

  it('leaves a generic project name untouched but still strips the source footer', () => {
    const out = sanitizeGlobalArticle({
      title: 'Foo for app',
      body: 'use app here\n\n## Source files\n\n- `x.ts`\n',
      projectName: 'app',
    });
    expect(out.body).not.toMatch(/source files/i);
    expect(out.body).toContain('use app here'); // generic word not replaced
    expect(out.title).toBe('Foo for app'); // generic name not scrubbed
  });

  it('strips the source footer even without a project name', () => {
    const out = sanitizeGlobalArticle({
      title: 'X',
      body: 'body text\n\n## Source files\n\n- `y.ts`\n',
    });
    expect(out.body).not.toMatch(/source files/i);
    expect(out.body).toContain('body text');
    expect(out.title).toBe('X');
  });

  it('keeps the original title when scrubbing would empty it', () => {
    expect(
      sanitizeGlobalArticle({ title: 'Siteray', body: '', projectName: 'siteray' }).title,
    ).toBe('Siteray');
  });

  // A description is the most-exposed text an entry has: it rides in front of every matching project.
  it('replaces the project name in a description, as it does in the body', () => {
    const out = sanitizeGlobalArticle({
      title: 'Vitest Quick Reference',
      body: 'b',
      description: 'How Siteray mocks @siteray/database in Vitest.',
      projectName: 'siteray',
    });
    expect(out.description).toBe('How example-app mocks @example-app/database in Vitest.');
  });

  it('leaves a generic project name in a description alone', () => {
    const out = sanitizeGlobalArticle({
      title: 'Foo',
      body: 'b',
      description: 'Use app here.',
      projectName: 'app',
    });
    expect(out.description).toBe('Use app here.');
  });

  it('has no description when it was given none', () => {
    expect(
      sanitizeGlobalArticle({ title: 'X', body: 'b', projectName: 'siteray' }).description,
    ).toBe(null);
    expect(sanitizeGlobalArticle({ title: 'X', body: 'b', description: null }).description).toBe(
      null,
    );
  });

  // A repository named after a technology is ABOUT it: rewriting its mentions corrupts the article.
  describe('a project named like a public technology', () => {
    const laravel = {
      title: 'Queue workers in Laravel',
      body: '# Laravel queues\n\nRun `php artisan queue:work` under a supervisor; Laravel Horizon reads the same queue.\n',
      description: 'How Laravel runs queue workers.',
    };

    it.each(['laravel', 'Laravel', ' LARAVEL '])(
      'leaves the title, description and body of a Laravel article alone for %j',
      (projectName) => {
        expect(sanitizeGlobalArticle({ ...laravel, projectName })).toEqual(laravel);
      },
    );

    it('does the same for Drupal', () => {
      const drupal = {
        title: 'Drupal render cache',
        body: '# Drupal\n\nA Drupal render array carries `#cache` metadata.\n',
        description: 'What Drupal expects in a render array.',
      };

      expect(sanitizeGlobalArticle({ ...drupal, projectName: 'Drupal' })).toEqual(drupal);
    });

    it.each([
      ['a framework', 'react'],
      ['a CMS', 'WordPress'],
      ['a language', 'Python'],
      ['a runtime', 'Node.js'],
      ['a database', 'PostgreSQL'],
      ['a cache', 'redis'],
      ['a server', 'nginx'],
    ])('does the same for %s, %s', (_kind, projectName) => {
      const article = {
        title: `${projectName} setup`,
        body: `Configure ${projectName} before the first deploy.\n`,
        description: `Setting up ${projectName}.`,
      };

      expect(sanitizeGlobalArticle({ ...article, projectName })).toEqual(article);
    });

    it('still strips the source footer', () => {
      const out = sanitizeGlobalArticle({
        title: 'X',
        body: 'Use Laravel.\n\n## Source files\n\n- `a.php`\n',
        projectName: 'laravel',
      });

      expect(out.body).toBe('Use Laravel.\n');
    });
  });

  describe('a project named like a value the article is scoped to', () => {
    const article = {
      title: 'Elmont routing',
      body: '# Elmont\n\nRoutes live in `elmont/routes.php`.\n',
      description: 'How Elmont resolves a route.',
    };

    it.each([
      ['a framework', { framework: ['elmont'] }],
      ['a value of another case', { language: ['Elmont'] }],
      ['a package, whose value ends in its major', { packages: ['elmont@2'] }],
    ])('leaves the article alone for %s', (_kind, facets) => {
      expect(sanitizeGlobalArticle({ ...article, projectName: 'elmont', facets })).toEqual(article);
    });

    it('still scrubs it when only a free-text tag names it, since tags are not scope', () => {
      const out = sanitizeGlobalArticle({
        ...article,
        projectName: 'elmont',
        facets: { tags: ['elmont'] },
      });

      expect(out.body).toBe('# example-app\n\nRoutes live in `example-app/routes.php`.\n');
    });

    it('still scrubs it when the scope names something else', () => {
      const out = sanitizeGlobalArticle({
        ...article,
        projectName: 'elmont',
        facets: { framework: ['laravel'], packages: ['vitest@3'] },
      });

      expect(out).toEqual({
        title: 'routing',
        body: '# example-app\n\nRoutes live in `example-app/routes.php`.\n',
        description: 'How example-app resolves a route.',
      });
    });
  });

  describe('the project name is matched as a whole token only', () => {
    const run = (text: string) =>
      sanitizeGlobalArticle({
        title: 'Theme',
        body: `use ${text} now\n`,
        description: `use ${text} now`,
        projectName: 'elmont',
      });

    it.each([
      ['elmont', 'example-app'],
      ['Elmont', 'example-app'],
      ['@elmont/ui', '@example-app/ui'],
      ['elmont-theme', 'example-app-theme'],
      ['packages/elmont/src', 'packages/example-app/src'],
      ['`elmont`', '`example-app`'],
      ['elmont.config.js', 'example-app.config.js'],
      ['my_elmont', 'my_example-app'],
      ['elmont_theme', 'example-app_theme'],
      ['elmont_form_alter()', 'example-app_form_alter()'],
    ])('rewrites %s as %s', (text, expected) => {
      const out = run(text);

      expect(out.body).toBe(`use ${expected} now\n`);
      expect(out.description).toBe(`use ${expected} now`);
    });

    it.each(['elmontish', 'elmont2', '2elmont', 'xElmont', 'elmontü', 'Éelmont', 'ΩElmont'])(
      'leaves %s alone',
      (text) => {
        const out = run(text);

        expect(out.body).toBe(`use ${text} now\n`);
        expect(out.description).toBe(`use ${text} now`);
      },
    );

    it('scrubs a title by the same rule', () => {
      const title = (t: string) =>
        sanitizeGlobalArticle({ title: t, body: 'b', projectName: 'elmont' }).title;

      expect(title('Routing in Elmont')).toBe('Routing');
      expect(title('Elmont Coding Standards')).toBe('Coding Standards');
      expect(title('Routing in Elmontish')).toBe('Routing in Elmontish');
      expect(title('Routing for my_elmont')).toBe('Routing for my_');
    });
  });
});
