import { describe, expect, it, vi } from 'vitest';
import { CliPickerGrid } from './cli-picker-grid';
import { createRenderer, findAll, textOf } from '../../test/render-tree';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../../test/render-tree')).reactHooks,
}));

const providers = [
  { id: 'p1', name: 'claude', label: 'Claude', enabled: true, effortScale: null },
] as never;
const slots = [{ id: 'a', label: 'Alpha' }];

function noneOptions(props: Record<string, unknown>): string[] {
  const view = createRenderer(() => (
    <CliPickerGrid
      providers={providers}
      idPrefix="s"
      defaultProviderId=""
      taskCliProviderId={null}
      onChange={() => {}}
      {...props}
    />
  ));
  return findAll(view.tree(), (h) => h.tag === 'option' && h.props.value === '')
    .map((h) => textOf(h))
    .filter((text) => text.startsWith('(none'));
}

describe('the none option of a step CLI dropdown', () => {
  it.each([
    ['the single dropdown', {}],
    ['a role dropdown', { roles: slots }],
    ['a seat dropdown', { seats: slots }],
  ])('reads (none — use the default) in %s', (_name, props) => {
    const texts = noneOptions(props);
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) {
      expect(text).toBe('(none — use the default)');
      expect(text).not.toMatch(/deterministic/i);
    }
  });
});
