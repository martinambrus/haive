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
  it('renders an issue message as markdown, in a row', () => {
    const catalog = {
      ...TEST_CATALOG,
      steps: TEST_CATALOG.steps.map((s) =>
        s.stepId === '05-phase-0b5-spec-quality'
          ? {
              ...s,
              entry: {
                ...s.entry,
                requires: [{ needs: 'spec', reason: 'Reviews the **pre-planning** spec' }],
              },
            }
          : s,
      ),
    };
    const html = renderToStaticMarkup(
      <TaskTypeComposer {...base} catalog={catalog} stepIds={['05-phase-0b5-spec-quality']} />,
    );
    expect(html).toContain('<strong>pre-planning</strong>');
    expect(html).not.toContain('**pre-planning**');
  });

  it('makes every control inert while disabled', () => {
    const html = renderToStaticMarkup(
      <TaskTypeComposer
        {...base}
        disabled
        loopLimits={{ '05-phase-0b5-spec-quality': 4 }}
        stepIds={['04-phase-0b-pre-planning', '05-phase-0b5-spec-quality']}
      />,
    );
    const controls = html.match(/<(button|input)\b[^>]*>/g) ?? [];
    expect(controls.length).toBeGreaterThan(5);
    for (const tag of controls) expect(tag).toContain('disabled=""');
    expect(html).not.toContain('draggable="true"');
  });

  it('puts the move and remove buttons on their own line under the label below the sm breakpoint', () => {
    const html = renderToStaticMarkup(
      <TaskTypeComposer
        {...base}
        stepIds={['04-phase-0b-pre-planning', '05-phase-0b5-spec-quality']}
      />,
    );
    const row = html.split('<li ')[1]!;
    const classesOf = (tag: string) => tag.split(' ');
    const line = classesOf(row.match(/<div class="([^"]*)">/)![1]!);
    expect(line).toEqual(expect.arrayContaining(['flex', 'items-start', 'gap-2']));
    expect(line).toEqual(expect.arrayContaining(['flex-wrap', 'sm:flex-nowrap']));
    const buttons = classesOf(row.match(/<div class="([^"]*)"><button[^>]*data-act="up"/)![1]!);
    expect(buttons).toEqual(expect.arrayContaining(['flex', 'shrink-0', 'gap-1']));
    expect(buttons).toEqual(expect.arrayContaining(['w-full', 'pl-8', 'sm:w-auto', 'sm:pl-0']));
    expect(row).toMatch(/<div class="[^"]*min-w-0 flex-1[^"]*"><p /);
    const labels = { up: 'Move ', down: 'Move ', remove: 'Remove ' };
    for (const [act, label] of Object.entries(labels)) {
      const tag = row.match(new RegExp(`<button[^>]*data-act="${act}"[^>]*>`))![0];
      expect(tag).toContain('h-11');
      expect(tag).toContain('min-w-11');
      expect(tag).toContain(`aria-label="${label}`);
    }
  });

  describe('prompt steps', () => {
    const step = {
      slug: 'ask',
      title: 'Ask the agent',
      template: 'Summarise {{task.title}}',
      capabilities: [] as [],
      tools: [],
      timeoutMs: 300_000,
    };
    const editing = {
      ...base,
      typeSlug: 't',
      promptSteps: { ask: step },
      onPromptStepsChange: noop,
    };

    it('offers no prompt-step controls unless the editor hands the composer a type and a handler', () => {
      const html = renderToStaticMarkup(
        <TaskTypeComposer {...base} stepIds={['04-phase-0b-pre-planning']} />,
      );
      expect(html).not.toContain('Add prompt step');
      expect(html).not.toContain('Prompt step<');
      const readOnly = renderToStaticMarkup(
        <TaskTypeComposer {...editing} readOnly stepIds={['custom.t.ask']} />,
      );
      expect(readOnly).not.toContain('Add prompt step');
      expect(readOnly).not.toContain('Edit');
    });

    it('shows a prompt step as a badged agent row with an Edit control and no problems', () => {
      const html = renderToStaticMarkup(
        <TaskTypeComposer {...editing} stepIds={['custom.t.ask']} />,
      );
      const row = html.split('<li ')[1]!;
      expect(row).toContain('Ask the agent');
      expect(row).toContain('Prompt step</span>');
      expect(row).toContain('custom.t.ask');
      expect(row).toContain('agent');
      expect(row).toContain('aria-label="Edit prompt step Ask the agent"');
      expect(row).toContain('aria-expanded="false"');
      expect(row).not.toContain('Prompt template');
      expect(html).toContain('No problems');
      expect(html).not.toContain('is not in the step catalog');
      expect(html).toContain('Add prompt step');
    });

    it('marks the row and says in words what is wrong with the template', () => {
      const html = renderToStaticMarkup(
        <TaskTypeComposer
          {...editing}
          promptSteps={{ ask: { ...step, template: 'Use {{bogus}}' } }}
          stepIds={['custom.t.ask']}
        />,
      );
      const row = html.split('<li ')[1]!;
      expect(row).toContain('border-red-800/70');
      expect(row).toContain('<code>{{bogus}}</code> is not a template token');
      expect(html).toContain('1 problem');
    });

    it('flags a prompt step that quotes one that runs later', () => {
      const html = renderToStaticMarkup(
        <TaskTypeComposer
          {...editing}
          promptSteps={{
            ask: { ...step, template: '{{step:custom.t.later}}' },
            later: { ...step, slug: 'later', title: 'Later' },
          }}
          stepIds={['custom.t.ask', 'custom.t.later']}
        />,
      );
      expect(html.split('<li ')[1]).toContain('does not run before this one');
      expect(html.split('<li ')[2]).not.toContain('does not run before this one');
    });

    it('puts a server issue on the row of its step and one with no row in the general list', () => {
      const html = renderToStaticMarkup(
        <TaskTypeComposer
          {...editing}
          stepIds={['custom.t.ask']}
          serverPromptIssues={[
            { kind: 'template-too-large', stepId: 'custom.t.ask' },
            { kind: 'prompt-step-orphan', stepId: 'custom.t.gone' },
          ]}
        />,
      );
      expect(html.split('<li ')[1]).toContain('over 16 KiB');
      expect(html).toContain('custom.t.gone is defined but is not in the step list');
      expect(html).toContain('2 problems');
    });

    it('disables Add prompt step until the task type has a valid slug', () => {
      const html = renderToStaticMarkup(
        <TaskTypeComposer {...editing} typeSlug="" stepIds={['04-phase-0b-pre-planning']} />,
      );
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Add prompt step<\/button>/);
      expect(html).toContain('Enter a valid slug for the task type first');
    });

    it('makes the prompt-step controls inert while disabled', () => {
      const html = renderToStaticMarkup(
        <TaskTypeComposer {...editing} disabled stepIds={['custom.t.ask']} />,
      );
      for (const tag of html.match(/<(button|input)\b[^>]*>/g) ?? []) {
        expect(tag).toContain('disabled=""');
      }
    });
  });
});
