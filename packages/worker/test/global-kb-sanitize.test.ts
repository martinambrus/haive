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
});
