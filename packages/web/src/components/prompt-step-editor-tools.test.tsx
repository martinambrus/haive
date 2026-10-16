import { describe, expect, it, vi } from 'vitest';
import {
  CUSTOM_TOOLS_MAX_PER_STEP,
  CUSTOM_TOOL_RESPONSE_MAX_BYTES,
  CUSTOM_TOOL_RESPONSE_MIN_BYTES,
  CUSTOM_TOOL_TIMEOUT_MAX_MS,
  CUSTOM_TOOL_TIMEOUT_MIN_MS,
  customToolSchema,
  validateCustomTool,
  type CustomTool,
  type HttpGetTool,
  type PromptStepEntry,
  type RagQueryTool,
} from '@haive/shared/modularity';
import { catalogEntries, describePromptStepIssue } from '@/lib/composition-messages';
import { TEST_CATALOG } from '@/lib/composition-test-catalog';
import { promptStepIssues, type PromptSteps } from '@/lib/prompt-step-editing';
import { PromptStepEditor } from './prompt-step-editor';
import { TaskTypeComposer } from './task-type-composer';
import {
  buttons,
  contains,
  controls,
  createRenderer,
  findAll,
  fire,
  isDisabled,
  norm,
  textOf,
  valueOf,
  type Host,
} from '../../test/render-tree';

// No DOM in this package: components run through test/render-tree.ts, and the markdown body is its plain text.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../../test/render-tree')).reactHooks,
}));
vi.mock('@/components/markdown/markdown-view', () => ({
  MarkdownView: ({ body }: { body: string }) => body,
}));

// The only wording these controls rely on: a visible label or an aria-label, lower-cased by norm().
const NAME = {
  addTool: /^add tool$/,
  removeTool: /^remove tool\b/,
  addParam: /^add param(eter)?$/,
  editStep: /^edit prompt step\b/,
  toolsHeading: /^(custom )?tools\b/,
  toolName: /^(tool )?name$/,
  toolDescription: /^(tool )?description$/,
  action: /^(tool )?action$/,
  url: /^(tool )?url$/,
  scope: /^(search )?scope$/,
  topK: /\b(top ?k|results)\b/,
  toolTimeout: /^timeout \(seconds\)$/,
  responseCap: /^response cap \(kib\)$/,
  paramName: /^param(eter)? name$/,
  paramType: /^param(eter)? type$/,
  paramDescription: /^param(eter)? description$/,
  required: /^(param(eter)? )?required$/,
  maxLength: /^max(imum)? length$/,
  min: /^min(imum)?$/,
  max: /^max(imum)?$/,
  values: /^(allowed )?values\b/,
};

const base: PromptStepEntry = {
  slug: 'a',
  title: 'Check it',
  template: 'Review {{task.title}}',
  capabilities: [],
  tools: [],
  timeoutMs: 600_000,
};
const httpTool = customToolSchema.parse({
  action: 'http-get',
  name: 'repo_status',
  description: 'Fetches the status of one repository.',
  url: 'https://api.example.com/v1/status',
}) as HttpGetTool;
const ragTool = customToolSchema.parse({
  action: 'rag-query',
  name: 'find_notes',
  description: 'Searches the stored notes.',
  scope: 'global',
}) as RagQueryTool;
const RAG_SCOPES = customToolSchema.options[1].shape.scope.options;

const withTools = (tools: CustomTool[]): PromptStepEntry => ({ ...base, tools });

interface Mounted {
  root: () => Host;
  draw: () => void;
}
interface MountedEditor extends Mounted {
  entry: () => PromptStepEntry;
  tools: () => CustomTool[];
}

function mountEditor(start: PromptStepEntry): MountedEditor {
  let entry = start;
  const view = createRenderer(() => (
    <PromptStepEditor
      entry={entry}
      onChange={(next) => {
        entry = next;
      }}
      onRemove={() => {}}
    />
  ));
  return {
    root: view.tree,
    draw: () => void view.draw(),
    entry: () => entry,
    tools: () => entry.tools ?? [],
  };
}

function mountComposer(promptSteps: PromptSteps): Mounted {
  let steps = promptSteps;
  const view = createRenderer(() => (
    <TaskTypeComposer
      catalog={TEST_CATALOG}
      stepIds={['custom.t.a']}
      loopLimits={{}}
      requiresRepository
      typeSlug="t"
      promptSteps={steps}
      onPromptStepsChange={(next) => {
        steps = next;
      }}
      onStepIdsChange={() => {}}
      onLoopLimitsChange={() => {}}
    />
  ));
  return { root: view.tree, draw: () => void view.draw() };
}

const need = <T,>(found: T | undefined, what: string): T => {
  if (found === undefined) throw new Error(`the editor shows no ${what}`);
  return found;
};
const field = (m: Mounted, spec: RegExp, within?: () => Host) =>
  need(controls(m.root(), spec, within?.())[0], `control named ${spec}`);
const press = (m: Mounted, spec: RegExp, within?: () => Host) =>
  need(buttons(m.root(), spec, within?.())[0], `button named ${spec}`);
const typeInto = (m: Mounted, spec: RegExp, value: string, within?: () => Host) => {
  fire.type(field(m, spec, within), value);
  m.draw();
};
const tick = (m: Mounted, spec: RegExp, checked: boolean, within?: () => Host) => {
  fire.check(field(m, spec, within), checked);
  m.draw();
};
const click = (m: Mounted, spec: RegExp, within?: () => Host) => {
  fire.click(press(m, spec, within));
  m.draw();
};

const ownText = (host: Host) =>
  norm(host.kids.filter((kid): kid is string => typeof kid === 'string').join(''));
const hasHeading = (m: Mounted, spec: RegExp) =>
  findAll(m.root(), (host) => spec.test(ownText(host))).length > 0;
const optionValues = (select: Host) =>
  findAll(select, (host) => host.tag === 'option').map((o) => String(o.props.value ?? textOf(o)));
const squash = (text: string) => text.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();

function rowOf(m: Mounted, name: string): Host {
  const names = controls(m.root(), NAME.toolName);
  const own = need(
    names.find((host) => valueOf(host) === name),
    `tool row named "${name}"`,
  );
  let row = own;
  for (let at = own.parent; at; at = at.parent) {
    if (names.filter((n) => contains(at, n)).length !== 1) break;
    row = at;
  }
  return row;
}

interface ParamCase {
  type: 'string' | 'integer' | 'boolean' | 'enum';
  name: string;
  description: string;
  required: boolean;
  extras: Array<[RegExp, string]>;
  param: Record<string, unknown>;
}

const PARAM_CASES: ParamCase[] = [
  {
    type: 'string',
    name: 'repo',
    description: 'The repository to look up.',
    required: true,
    extras: [[NAME.maxLength, '64']],
    param: { type: 'string', required: true, maxLength: 64 },
  },
  {
    type: 'integer',
    name: 'limit',
    description: 'How many rows to return.',
    required: false,
    extras: [
      [NAME.min, '1'],
      [NAME.max, '50'],
    ],
    param: { type: 'integer', required: false, min: 1, max: 50 },
  },
  {
    type: 'boolean',
    name: 'verbose',
    description: 'Include the details.',
    required: false,
    extras: [],
    param: { type: 'boolean', required: false },
  },
  {
    type: 'enum',
    name: 'state',
    description: 'Which state to list.',
    required: true,
    extras: [[NAME.values, 'open\nclosed']],
    param: { type: 'enum', required: true, values: ['open', 'closed'] },
  },
];

function chooseAction(m: Mounted, action: 'http-get' | 'rag-query', within?: () => Host) {
  if (valueOf(field(m, NAME.action, within)) !== action) typeInto(m, NAME.action, action, within);
}

describe('PromptStepEditor tools: the harness itself', () => {
  it('H0 drives a field and a button of the editor as it is today', () => {
    const m = mountEditor(base);
    typeInto(m, /^title$/, 'Renamed');
    expect(m.entry().title).toBe('Renamed');
    expect(buttons(m.root(), /^remove prompt step$/)).toHaveLength(1);
  });

  it('H7 opens the editor of a prompt step inside the composer as it is today', () => {
    const m = mountComposer({ a: base });
    expect(controls(m.root(), /^title$/)).toHaveLength(0);
    click(m, NAME.editStep);
    expect(controls(m.root(), /^title$/)).toHaveLength(1);
  });
});

describe('PromptStepEditor tools', () => {
  it('W1 adds an http-get tool from a Tools section and emits it with the schema defaults', () => {
    const m = mountEditor(base);
    expect(hasHeading(m, NAME.toolsHeading), 'a Tools heading').toBe(true);
    click(m, NAME.addTool);
    expect(m.tools()).toHaveLength(1);
    chooseAction(m, 'http-get');
    typeInto(m, NAME.toolName, 'repo_status');
    typeInto(m, NAME.toolDescription, 'Fetches the status of one repository.');
    typeInto(m, NAME.url, 'https://api.example.com/v1/status');
    expect(m.tools()).toEqual([
      customToolSchema.parse({
        action: 'http-get',
        name: 'repo_status',
        description: 'Fetches the status of one repository.',
        url: 'https://api.example.com/v1/status',
      }),
    ]);
  });

  it('W2 draws an entry saved before tools existed with no tool rows and lets one be added', () => {
    const old = { ...base, tools: undefined } as unknown as PromptStepEntry;
    expect(() => mountEditor(old)).not.toThrow();
    const m = mountEditor(old);
    expect(hasHeading(m, NAME.toolsHeading), 'a Tools heading').toBe(true);
    expect(controls(m.root(), NAME.toolName)).toHaveLength(0);
    click(m, NAME.addTool);
    expect(m.tools()).toHaveLength(1);
    expect(controls(m.root(), NAME.toolName)).toHaveLength(1);
  });

  it('W3 removes a tool from its own row and stops adding at the per-step maximum', () => {
    const m = mountEditor(withTools([httpTool, ragTool]));
    click(m, NAME.removeTool, () => rowOf(m, httpTool.name));
    expect(m.tools()).toEqual([ragTool]);

    const many = Array.from({ length: CUSTOM_TOOLS_MAX_PER_STEP }, (_, i) => ({
      ...ragTool,
      name: `tool_${i}`,
    }));
    expect(isDisabled(press(mountEditor(withTools(many)), NAME.addTool))).toBe(true);
    const almost = mountEditor(withTools(many.slice(1)));
    expect(isDisabled(press(almost, NAME.addTool))).toBe(false);
    click(almost, NAME.addTool);
    expect(almost.tools()).toHaveLength(CUSTOM_TOOLS_MAX_PER_STEP);
  });

  it('W4 offers the scopes and a top K on a rag-query row, and keeps name and description when the action switches', () => {
    const m = mountEditor(withTools([ragTool]));
    const scope = field(m, NAME.scope);
    expect(
      optionValues(scope)
        .filter((v) => v !== '')
        .sort(),
    ).toEqual([...RAG_SCOPES].sort());
    expect(valueOf(scope)).toBe(ragTool.scope);
    expect(valueOf(field(m, NAME.topK))).toBe(String(ragTool.topK));
    typeInto(m, NAME.topK, '5');
    typeInto(m, NAME.scope, 'project');
    expect(m.tools()).toEqual([{ ...ragTool, topK: 5, scope: 'project' }]);

    const s = mountEditor(withTools([httpTool]));
    typeInto(s, NAME.action, 'rag-query');
    const switched = s.tools()[0];
    expect(switched).toMatchObject({
      action: 'rag-query',
      name: httpTool.name,
      description: httpTool.description,
    });
    expect(customToolSchema.parse(switched)).toEqual(switched);
    typeInto(s, NAME.action, 'http-get');
    expect(s.tools()[0]).toMatchObject({
      action: 'http-get',
      name: httpTool.name,
      description: httpTool.description,
    });
  });

  it('W5 adds a parameter of each type in the row and lands it in tool.params with its extras', () => {
    for (const c of PARAM_CASES) {
      const m = mountEditor(withTools([httpTool]));
      const row = () => rowOf(m, httpTool.name);
      click(m, NAME.addParam, row);
      if (valueOf(field(m, NAME.paramType, row)) !== c.type) {
        typeInto(m, NAME.paramType, c.type, row);
      }
      typeInto(m, NAME.paramName, c.name, row);
      typeInto(m, NAME.paramDescription, c.description, row);
      if (c.required) tick(m, NAME.required, true, row);
      for (const [label, value] of c.extras) typeInto(m, label, value, row);
      const tool = customToolSchema.parse(m.tools()[0]) as HttpGetTool;
      expect(tool.params, `a ${c.type} parameter`).toEqual([
        { name: c.name, description: c.description, ...c.param },
      ]);
    }
  });

  it('W7 shows the message of a tool problem on that tool row and not on the other', () => {
    const bad: HttpGetTool = { ...httpTool, url: 'http://api.example.com/v1/status' };
    const promptSteps = { a: withTools([bad, ragTool]) };
    const found = promptStepIssues({
      typeSlug: 't',
      stepIds: ['custom.t.a'],
      requiresRepository: true,
      promptSteps,
      catalog: catalogEntries(TEST_CATALOG),
    });
    const kind = validateCustomTool(bad, { requiresRepository: true })[0]!.kind;
    expect(found.map((i) => [i.kind, i.raw])).toEqual([[kind, bad.name]]);

    const m = mountComposer(promptSteps);
    if (controls(m.root(), NAME.toolName).length === 0) click(m, NAME.editStep);
    const message = squash(describePromptStepIssue(found[0]!));
    expect(squash(textOf(rowOf(m, bad.name)))).toContain(message);
    expect(squash(textOf(rowOf(m, ragTool.name)))).not.toContain(message);
  });
});

describe('PromptStepEditor tool limits', () => {
  const tooSlow: HttpGetTool = { ...httpTool, timeoutMs: 90_000, maxResponseBytes: 100 };
  const kinds = (tool: CustomTool) =>
    validateCustomTool(tool, { requiresRepository: true }).map((p) => p.kind);

  it('shows the timeout in seconds and the response cap in KiB, bounded as the api bounds them', () => {
    const m = mountEditor(withTools([httpTool]));
    const timeout = field(m, NAME.toolTimeout);
    expect(timeout.props.type).toBe('number');
    expect(valueOf(timeout)).toBe(String(httpTool.timeoutMs / 1000));
    expect(timeout.props.min).toBe(CUSTOM_TOOL_TIMEOUT_MIN_MS / 1000);
    expect(timeout.props.max).toBe(CUSTOM_TOOL_TIMEOUT_MAX_MS / 1000);
    const cap = field(m, NAME.responseCap);
    expect(cap.props.type).toBe('number');
    expect(valueOf(cap)).toBe(String(httpTool.maxResponseBytes / 1024));
    expect(cap.props.min).toBe(CUSTOM_TOOL_RESPONSE_MIN_BYTES / 1024);
    expect(cap.props.max).toBe(CUSTOM_TOOL_RESPONSE_MAX_BYTES / 1024);
  });

  it('writes what is typed as milliseconds and bytes, and keeps the rest of the tool', () => {
    const m = mountEditor(withTools([httpTool]));
    typeInto(m, NAME.toolTimeout, '20');
    expect(m.tools()).toEqual([{ ...httpTool, timeoutMs: 20_000 }]);
    typeInto(m, NAME.responseCap, '48');
    expect(m.tools()).toEqual([{ ...httpTool, timeoutMs: 20_000, maxResponseBytes: 49_152 }]);
    typeInto(m, NAME.toolTimeout, '1.5');
    expect(m.tools()[0]).toMatchObject({ timeoutMs: 1_500 });
    expect(customToolSchema.parse(m.tools()[0])).toEqual(m.tools()[0]);
  });

  it('holds a cleared field at 0, which save refuses, until another number is typed', () => {
    const m = mountEditor(withTools([httpTool]));
    typeInto(m, NAME.toolTimeout, '');
    expect(valueOf(field(m, NAME.toolTimeout))).toBe('');
    expect(m.tools()[0]).toMatchObject({ timeoutMs: 0 });
    typeInto(m, NAME.responseCap, '');
    expect(m.tools()[0]).toMatchObject({ maxResponseBytes: 0 });
    typeInto(m, NAME.toolTimeout, '5');
    expect(m.tools()[0]).toMatchObject({ timeoutMs: 5_000 });
  });

  it('offers the response cap and no timeout on a rag-query tool', () => {
    const m = mountEditor(withTools([ragTool]));
    expect(controls(m.root(), NAME.toolTimeout)).toHaveLength(0);
    expect(valueOf(field(m, NAME.responseCap))).toBe(String(ragTool.maxResponseBytes / 1024));
    typeInto(m, NAME.responseCap, '64');
    expect(m.tools()).toEqual([{ ...ragTool, maxResponseBytes: CUSTOM_TOOL_RESPONSE_MAX_BYTES }]);
  });

  it('keeps the cap through a change of action, and brings the timeout back at its default', () => {
    const m = mountEditor(withTools([httpTool]));
    typeInto(m, NAME.responseCap, '48');
    typeInto(m, NAME.action, 'rag-query');
    expect(controls(m.root(), NAME.toolTimeout)).toHaveLength(0);
    expect(valueOf(field(m, NAME.responseCap))).toBe('48');
    typeInto(m, NAME.action, 'http-get');
    expect(valueOf(field(m, NAME.toolTimeout))).toBe(String(httpTool.timeoutMs / 1000));
    expect(valueOf(field(m, NAME.responseCap))).toBe('48');
  });

  it('mends a stored tool whose timeout and cap save refuses, without removing the tool', () => {
    expect(kinds(tooSlow)).toEqual(['tool-timeout-out-of-range', 'tool-response-cap-out-of-range']);
    const promptSteps = { a: withTools([tooSlow]) };
    const found = promptStepIssues({
      typeSlug: 't',
      stepIds: ['custom.t.a'],
      requiresRepository: true,
      promptSteps,
      catalog: catalogEntries(TEST_CATALOG),
    });
    const [timeoutProblem, capProblem] = found.map((issue) =>
      squash(describePromptStepIssue(issue)),
    );
    expect(found.map((issue) => issue.kind)).toEqual(kinds(tooSlow));

    const m = mountComposer(promptSteps);
    click(m, NAME.editStep);
    expect(valueOf(field(m, NAME.toolTimeout))).toBe('90');
    expect(valueOf(field(m, NAME.responseCap))).toBe('0.09765625');
    expect(squash(textOf(rowOf(m, tooSlow.name)))).toContain(timeoutProblem);
    expect(squash(textOf(rowOf(m, tooSlow.name)))).toContain(capProblem);

    typeInto(m, NAME.toolTimeout, '30');
    typeInto(m, NAME.responseCap, '1');
    expect(squash(textOf(m.root()))).not.toContain(timeoutProblem);
    expect(squash(textOf(m.root()))).not.toContain(capProblem);
    expect(squash(textOf(m.root()))).toContain('No problems');
    expect(controls(m.root(), NAME.toolName)).toHaveLength(1);
  });

  it('judges a value typed above the bound as save does, instead of clamping it', () => {
    const m = mountEditor(withTools([httpTool]));
    typeInto(m, NAME.toolTimeout, '31');
    expect(m.tools()[0]).toMatchObject({ timeoutMs: 31_000 });
    expect(kinds(m.tools()[0]!)).toEqual(['tool-timeout-out-of-range']);
    typeInto(m, NAME.responseCap, '65');
    expect(kinds(m.tools()[0]!)).toEqual([
      'tool-timeout-out-of-range',
      'tool-response-cap-out-of-range',
    ]);
  });
});
