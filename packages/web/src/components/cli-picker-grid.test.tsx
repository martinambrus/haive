import { describe, expect, it, vi } from 'vitest';
import { CliPickerGrid } from './cli-picker-grid';
import { createRenderer, findAll, fire, textOf } from '../../test/render-tree';

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

describe('the none option names the fallback provider', () => {
  const NAMED = '(none — use the default: Claude)';
  const PLAIN = '(none — use the default)';

  it.each([
    ['the single dropdown', {}],
    ['a role dropdown', { roles: slots }],
  ])('reads the provider label in %s when fallbackProviderId is a listed provider', (_n, props) => {
    const texts = noneOptions({ ...props, fallbackProviderId: 'p1' });
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) expect(text).toBe(NAMED);
  });

  it('keeps a seat dropdown on the generic text', () => {
    const view = createRenderer(() => (
      <CliPickerGrid
        providers={providers}
        idPrefix="s"
        defaultProviderId=""
        taskCliProviderId={null}
        fallbackProviderId="p1"
        seats={slots}
        onChange={() => {}}
      />
    ));
    const seat = findAll(view.tree(), (h) => h.tag === 'select' && h.props.id === 's-seat-a')[0];
    const texts = findAll(seat as never, (h) => h.tag === 'option' && h.props.value === '').map(
      (h) => textOf(h),
    );
    expect(texts).toContain(PLAIN);
    expect(texts).not.toContain(NAMED);
  });

  it.each([
    ['absent', {}],
    ['an unknown id', { fallbackProviderId: 'nope' }],
    ['null', { fallbackProviderId: null }],
  ])('keeps the generic text when the prop is %s', (_n, extra) => {
    for (const props of [{}, { roles: slots }, { seats: slots }]) {
      const texts = noneOptions({ ...props, ...extra });
      expect(texts.length).toBeGreaterThan(0);
      for (const text of texts) expect(text).toBe(PLAIN);
    }
  });

  it('leaves the select value empty and reports null when the empty option is chosen', () => {
    const calls: unknown[][] = [];
    const view = createRenderer(() => (
      <CliPickerGrid
        providers={providers}
        idPrefix="s"
        defaultProviderId=""
        taskCliProviderId={null}
        fallbackProviderId="p1"
        onChange={(...args: unknown[]) => calls.push(args)}
      />
    ));
    const select = findAll(view.tree(), (h) => h.tag === 'select' && h.props.id === 's')[0];
    expect(select?.props.value).toBe('');
    fire.type(select!, '');
    expect(calls[0]?.[0]).toBeNull();
  });
});
