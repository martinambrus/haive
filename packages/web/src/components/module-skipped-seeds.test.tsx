import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SkippedSeed } from '@haive/shared/modularity';
import { ModuleSkippedSeeds } from './module-skipped-seeds';

const row = (id: string, skippedSeeds: SkippedSeed[] = []) => ({ id, skippedSeeds });
const render = (rows: ReturnType<typeof row>[]) =>
  renderToStaticMarkup(<ModuleSkippedSeeds rows={rows} />);

describe('ModuleSkippedSeeds', () => {
  it('renders nothing while no module has a seed the worker skipped', () => {
    expect(render([])).toBe('');
    expect(render([row('alpha'), row('beta')])).toBe('');
  });

  it('names a slug another row holds, the module that declared it and the source holding it', () => {
    const html = render([
      row('alpha', [{ slug: 'alpha__weekly', reason: 'conflict', heldBy: 'admin' }]),
    ]);
    expect(html).toContain('<code>alpha__weekly</code>');
    expect(html).toContain('<code>alpha</code>');
    expect(html).toContain('held by another row');
    expect(html).toContain('<code>admin</code>');
  });

  it('names a seed that failed the checks, with the kind of each problem', () => {
    const html = render([
      row('alpha', [
        { slug: 'alpha__daily', reason: 'invalid', issues: ['unmet-need', 'unknown-step'] },
      ]),
    ]);
    expect(html).toContain('<code>alpha__daily</code>');
    expect(html).toContain('fails the checks');
    expect(html).toContain('unmet-need, unknown-step');
  });

  it('keeps a seed whose problems it cannot name, without a dangling list', () => {
    const html = render([row('alpha', [{ slug: 'alpha__daily', reason: 'invalid', issues: [] }])]);
    expect(html).toContain('<code>alpha__daily</code>');
    expect(html).toContain('fails the checks');
    expect(html).not.toMatch(/checks[^<]*:\s*[.<]/);
  });

  it('lists the seeds of every module in row order and skips a module with none', () => {
    const html = render([
      row('alpha', [{ slug: 'alpha__a', reason: 'conflict', heldBy: 'builtin' }]),
      row('beta'),
      row('gamma', [{ slug: 'gamma__b', reason: 'invalid', issues: ['empty'] }]),
    ]);
    expect(html.match(/<li/g)).toHaveLength(2);
    expect(html.indexOf('alpha__a')).toBeLessThan(html.indexOf('gamma__b'));
    expect(html).not.toContain('beta');
  });

  it('escapes what the report carried as text', () => {
    const html = render([
      row('alpha', [{ slug: '<b>alpha__x</b>', reason: 'conflict', heldBy: '<i>admin</i>' }]),
    ]);
    expect(html).toContain('&lt;b&gt;alpha__x&lt;/b&gt;');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<i>');
  });

  it('says the seeds were skipped at the last worker boot and where the details are', () => {
    const html = render([
      row('alpha', [{ slug: 'alpha__a', reason: 'conflict', heldBy: 'admin' }]),
    ]);
    expect(html).toContain('Task type seeds the worker skipped');
    expect(html).toContain('last boot');
    expect(html).toContain('worker log');
  });
});
