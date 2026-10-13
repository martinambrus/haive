import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskTypeComposer } from './task-type-composer';
import { TEST_CATALOG } from '@/lib/composition-test-catalog';

const noop = () => {};
const base = {
  catalog: TEST_CATALOG,
  loopLimits: {},
  requiresRepository: false,
  onStepIdsChange: noop,
  onLoopLimitsChange: noop,
};

describe('TaskTypeComposer', () => {
  it('shows each row its own problem and a summary', () => {
    const html = renderToStaticMarkup(
      <TaskTypeComposer
        {...base}
        stepIds={['05-phase-0b5-spec-quality', '03-phase-0a-discovery']}
      />,
    );
    const rows = html.split('<li ').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Needs spec first: Reviews the pre-planning spec.');
    expect(rows[0]).toContain('Provided by');
    expect(rows[1]).not.toContain('Needs spec first');
    expect(rows[1]).toContain('Must run before any step that provides spec');
    expect(html).toContain('2 problems');
    expect(html).toContain('aria-label="Move Phase 0b.5: Spec quality review down"');
    expect(html).toContain('aria-label="Remove Phase 0a: Knowledge discovery"');
  });

  it('reports no problems for a sound order', () => {
    const html = renderToStaticMarkup(
      <TaskTypeComposer
        {...base}
        stepIds={['04-phase-0b-pre-planning', '05-phase-0b5-spec-quality']}
      />,
    );
    expect(html).toContain('No problems');
    expect(html).not.toContain('Needs spec first');
  });

  it('renders a loop-limit input only for a step that allows one', () => {
    const html = renderToStaticMarkup(
      <TaskTypeComposer
        {...base}
        loopLimits={{ '05-phase-0b5-spec-quality': 4 }}
        stepIds={['04-phase-0b-pre-planning', '05-phase-0b5-spec-quality']}
      />,
    );
    expect(html.match(/type="number"/g)).toHaveLength(1);
    expect(html).toContain('value="4"');
  });

  it('shows the fixed fix-loop target next to the step that loops', () => {
    const html = renderToStaticMarkup(
      <TaskTypeComposer
        {...base}
        requiresRepository
        stepIds={['01-worktree-setup', '07-phase-2-implement', '07b-phase-4-validate']}
      />,
    );
    expect(html).toContain('Fix loops return to Phase 2: Implement');
  });

  it('marks agent steps and lists needs and provides as chips', () => {
    const html = renderToStaticMarkup(
      <TaskTypeComposer {...base} stepIds={['05-phase-0b5-spec-quality']} />,
    );
    expect(html).toContain('agent');
    expect(html).toContain('needs');
    expect(html).toContain('provides');
  });

  it('is read-only for a built-in row: no edit controls, no palette', () => {
    const html = renderToStaticMarkup(
      <TaskTypeComposer
        {...base}
        readOnly
        stepIds={['05-phase-0b5-spec-quality', '03-phase-0a-discovery']}
      />,
    );
    expect(html).toContain('Phase 0b.5: Spec quality review');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('draggable');
    expect(html).not.toContain('Needs spec first');
  });

  it('says the steps are chosen at run time when there is no list', () => {
    const html = renderToStaticMarkup(<TaskTypeComposer {...base} readOnly stepIds={null} />);
    expect(html).toContain('Steps chosen at run time');
  });

  it('lists the palette grouped, in catalog group order', () => {
    const html = renderToStaticMarkup(<TaskTypeComposer {...base} stepIds={[]} />);
    expect(html).toContain('Add at least one step.');
    expect(html.indexOf('Setup')).toBeLessThan(html.indexOf('Specification'));
    expect(html.indexOf('Specification')).toBeLessThan(html.indexOf('Build'));
    expect(html).toContain('aria-label="Add Phase 2: Implement"');
  });
});
