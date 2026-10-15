import { describe, expect, it, vi } from 'vitest';
import {
  customToolSchema,
  type CustomToolParam,
  type HttpGetTool,
  type PromptStepEntry,
} from '@haive/shared/modularity';
import { describePromptStepIssue, type PromptStepIssue } from '@/lib/composition-messages';
import { TEST_CATALOG } from '@/lib/composition-test-catalog';
import { newTool } from '@/lib/prompt-step-editing';
import { PromptStepEditor } from './prompt-step-editor';
import { TaskTypeComposer } from './task-type-composer';
import {
  buttons,
  contains,
  controls,
  createRenderer,
  fire,
  textOf,
  valueOf,
  type Host,
  type Renderer,
} from '../../test/render-tree';

// No DOM in this package: components run through test/render-tree.ts, and the markdown body is its plain text.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../../test/render-tree')).reactHooks,
}));
vi.mock('@/components/markdown/markdown-view', () => ({
  MarkdownView: ({ body }: { body: string }) => body,
}));

const base: PromptStepEntry = {
  slug: 'a',
  title: 'Check it',
  template: 'Review {{task.title}}',
  capabilities: [],
  tools: [],
  timeoutMs: 600_000,
};
const httpTool = (name: string, params: CustomToolParam[] = []): HttpGetTool => ({
  ...(customToolSchema.parse({
    action: 'http-get',
    name,
    description: 'Fetches it.',
    url: 'https://api.example.com/v1/status',
  }) as HttpGetTool),
  params,
});
const param = (name: string, rest: Record<string, unknown>) =>
  ({ name, description: 'The value.', required: false, ...rest }) as CustomToolParam;

function mountEditor(start: PromptStepEntry) {
  let entry = start;
  const view = createRenderer(() => (
    <PromptStepEditor entry={entry} onChange={(next) => (entry = next)} onRemove={() => {}} />
  ));
  const find = (name: RegExp) => controls(view.tree(), name)[0]!;
  return {
    find,
    tags: (name: RegExp) => controls(view.tree(), name).map((host) => host.tag),
    type: (name: RegExp, text: string) => {
      fire.type(find(name), text);
      view.draw();
    },
    press: (name: RegExp) => {
      fire.click(buttons(view.tree(), name)[0]!);
      view.draw();
    },
    tool: () => entry.tools[0] as HttpGetTool,
    params: () => (entry.tools[0] as HttpGetTool).params,
  };
}

describe('a tool parameter field that parses what is typed', () => {
  it('keeps the text while it still reads as the value, so a line break can be typed', () => {
    const m = mountEditor({
      ...base,
      tools: [httpTool('t', [param('state', { type: 'enum', values: ['open'] })])],
    });
    m.type(/^values\b/, 'open\n');
    expect(valueOf(m.find(/^values\b/))).toBe('open\n');
    expect(m.params()[0]).toMatchObject({ values: ['open'] });
    m.type(/^values\b/, 'open\n\nclosed');
    expect(valueOf(m.find(/^values\b/))).toBe('open\n\nclosed');
    expect(m.params()[0]).toMatchObject({ values: ['open', 'closed'] });
  });

  it('still reads the query parameter names as a comma separated list', () => {
    const m = mountEditor({ ...base, tools: [httpTool('t')] });
    m.type(/^query parameters$/, 'page, limit,');
    expect(m.tool().query).toEqual(['page', 'limit']);
  });

  it('turns a line break typed or pasted into a tool description into a space', () => {
    const m = mountEditor({ ...base, tools: [httpTool('t')] });
    m.type(/^description$/, 'Fetches it.\nThen lists it.\r\n\r\nDone.');
    expect(m.tool().description).toBe('Fetches it. Then lists it. Done.');
  });

  it('lets a required number be cleared, holding it at 0 until another is typed', () => {
    const m = mountEditor({
      ...base,
      tools: [httpTool('t', [param('q', { type: 'string', maxLength: 64 })])],
    });
    m.type(/^max length$/, '');
    expect(valueOf(m.find(/^max length$/))).toBe('');
    expect(m.params()[0]).toMatchObject({ maxLength: 0 });
    m.type(/^max length$/, '32');
    expect(m.params()[0]).toMatchObject({ maxLength: 32 });
  });

  it('leaves an optional number out when it is cleared', () => {
    const m = mountEditor({
      ...base,
      tools: [httpTool('t', [param('n', { type: 'integer', min: 3 })])],
    });
    m.type(/^min$/, '');
    expect(m.params()[0]).not.toHaveProperty('min', expect.anything());
  });

  it('shows the row that moves up its own value when the one before it is removed', () => {
    const m = mountEditor({
      ...base,
      tools: [
        httpTool('t', [
          param('a', { type: 'string', maxLength: 10 }),
          param('b', { type: 'string', maxLength: 20 }),
        ]),
      ],
    });
    m.press(/^remove parameter a$/);
    expect(valueOf(m.find(/^max length$/))).toBe('20');
  });
});

describe('the values of an enum parameter', () => {
  const VALUES = /^values\b/;
  const mountState = (values: string[]) =>
    mountEditor({ ...base, tools: [httpTool('t', [param('state', { type: 'enum', values })])] });

  it('is a textarea named Values (one per line)', () => {
    expect(mountState(['open']).tags(/^values \(one per line\)$/)).toEqual(['textarea']);
  });

  it('shows and reads back a value with a comma or surrounding spaces unchanged', () => {
    const values = ['Washington, D.C.', ' padded ', 'plain'];
    const m = mountState(values);
    const shown = valueOf(m.find(VALUES));
    expect(shown).toBe('Washington, D.C.\n padded \nplain');
    m.type(VALUES, shown);
    expect(m.params()[0]).toMatchObject({ values });
    m.type(VALUES, `${shown}\nlast`);
    expect(m.params()[0]).toMatchObject({ values: [...values, 'last'] });
  });

  it('reads one value a line, dropping blank lines and trimming nothing', () => {
    const m = mountState(['x']);
    m.type(VALUES, 'a\nb\n\nc');
    expect(m.params()[0]).toMatchObject({ values: ['a', 'b', 'c'] });
    m.type(VALUES, ' a \r\n\r\n  \r\nb,c');
    expect(m.params()[0]).toMatchObject({ values: [' a ', 'b,c'] });
  });
});

describe('where the composer puts a problem with a tool', () => {
  const bad = { ...httpTool('repo_status'), url: 'http://api.example.com/v1/status' };
  const asked = (kind: PromptStepIssue['kind'], raw?: string) =>
    describePromptStepIssue({ kind, stepId: 's', ...(raw === undefined ? {} : { raw }) });
  const times = (view: Renderer, text: string) => textOf(view.tree()).split(text).length - 1;

  function mountComposer(tools: PromptStepEntry['tools'], server: PromptStepIssue[] = []) {
    return createRenderer(() => (
      <TaskTypeComposer
        catalog={TEST_CATALOG}
        stepIds={['custom.t.a']}
        loopLimits={{}}
        requiresRepository
        typeSlug="t"
        promptSteps={{ a: { ...base, tools } }}
        serverPromptIssues={server}
        onPromptStepsChange={() => {}}
        onStepIdsChange={() => {}}
        onLoopLimitsChange={() => {}}
      />
    ));
  }
  const open = (view: Renderer) => {
    fire.click(buttons(view.tree(), /^edit prompt step\b/)[0]!);
    view.draw();
  };
  function rowOf(view: Renderer, name: string): Host {
    const names = controls(view.tree(), /^name$/);
    let row = names.find((host) => valueOf(host) === name)!;
    for (let at = row.parent; at; at = at.parent) {
      if (names.filter((n) => contains(at, n)).length !== 1) break;
      row = at;
    }
    return row;
  }

  it('says it under the step while the editor is closed, and once on its row when it is open', () => {
    const message = asked('tool-url-not-https', 'repo_status');
    const view = mountComposer([bad, httpTool('other')]);
    expect(times(view, message)).toBe(1);
    expect(controls(view.tree(), /^name$/)).toHaveLength(0);
    open(view);
    expect(times(view, message)).toBe(1);
    expect(textOf(rowOf(view, 'repo_status'))).toContain(message);
  });

  it('keeps a problem with the whole list on the step, even beside a tool that has no name yet', () => {
    const message = asked('too-many-tools');
    const view = mountComposer(
      [newTool(), httpTool('other')],
      [{ kind: 'too-many-tools', stepId: 'custom.t.a', raw: '' }],
    );
    open(view);
    expect(times(view, message)).toBe(1);
    expect(textOf(rowOf(view, ''))).not.toContain(message);
  });
});
