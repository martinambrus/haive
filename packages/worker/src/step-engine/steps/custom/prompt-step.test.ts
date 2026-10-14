import { describe, expect, it } from 'vitest';
import { promptStepEntrySchema } from '@haive/shared/modularity';
import {
  UNTRUSTED_OPEN,
  REPO_IS_DATA_ACTING_LINES,
  REPO_IS_DATA_LINES,
} from '../_untrusted-repo.js';
import type { StepContext } from '../../step-definition.js';
import {
  PROMPT_STEP_OUTPUT_CAP_BYTES,
  PROMPT_STEP_PERSONAS_UNSUPPORTED,
  buildPromptStep,
} from './prompt-step.js';

const ID = 'custom.demo.summarise';
const make = (over: Record<string, unknown> = {}) =>
  promptStepEntrySchema.parse({
    slug: 'summarise',
    title: 'Summarise',
    template: 'Topic: {{field:topic}}\nTitle: {{task.title}}\nBrief: {{task.description}}',
    paramFormSchema: { title: 'Params', fields: [{ id: 'topic', label: 'Topic', type: 'text' }] },
    capabilities: [],
    timeoutMs: 120_000,
    ...over,
  });
const detected = (over: Record<string, unknown> = {}) => ({
  taskTitle: 'The title',
  taskDescription: 'The brief',
  stepOutputs: {},
  ...over,
});
const prompt = (
  entry = make(),
  d = detected(),
  formValues: Record<string, unknown> = { topic: 'cats' },
) => buildPromptStep(ID, entry, 0).llm!.buildPrompt({ detected: d, formValues });

describe('prompt step metadata', () => {
  it('is a custom CLI step with the entry capabilities and no skip, provider or role flags', () => {
    const def = buildPromptStep(ID, make({ capabilities: ['tool_use'] }), 3);
    expect(def.metadata).toMatchObject({
      id: ID,
      workflowType: 'custom',
      index: 3,
      title: 'Summarise',
      requiresCli: true,
      requiredCapabilities: ['tool_use'],
    });
    expect(def.metadata.allowSkip).toBeUndefined();
    expect(def.metadata.providerSensitive).toBeUndefined();
    expect(def.metadata.cliRoles).toBeUndefined();
    expect(def.llm!.requiredCapabilities).toEqual(['tool_use']);
    expect(def.llm!.timeoutMs).toBe(120_000);
  });

  it('takes the entry form and never sets the agent rules, tool or MCP levers from data', () => {
    const def = buildPromptStep(ID, make(), 0);
    expect(def.form!({} as StepContext, detected())).toEqual(make().paramFormSchema);
    expect(def.llm!.skipAgentRules).toBeUndefined();
    expect(def.llm!.toolProfile).toBeUndefined();
    expect(def.llm!.disableTools).toBeUndefined();
    expect(buildPromptStep(ID, make({ agentPool: '*' }), 0).llm!.agentPool).toBe('*');
    expect(def.llm!.agentPool).toBeUndefined();
  });

  it('has no form when the entry declares none', () => {
    const { paramFormSchema: _drop, ...rest } = make();
    expect(
      buildPromptStep(ID, rest as ReturnType<typeof make>, 0).form!(
        {} as StepContext,
        detected() as never,
      ),
    ).toBeNull();
  });
});

describe('prompt step prompt', () => {
  it('renders the field, the title and the description', () => {
    const text = prompt();
    expect(text).toContain('Topic: cats');
    expect(text).toContain('Title: The title');
    expect(text).toContain('Brief: The brief');
  });

  it('fences an earlier step output as untrusted agent text', () => {
    const entry = make({ template: 'Before\n{{step:01-first}}\nAfter' });
    const text = prompt(entry, detected({ stepOutputs: { '01-first': 'EARLIER OUTPUT' } }));
    const open = text.indexOf(UNTRUSTED_OPEN);
    expect(open).toBeGreaterThan(text.indexOf('Before'));
    expect(text.indexOf('EARLIER OUTPUT')).toBeGreaterThan(open);
    expect(text.indexOf('After')).toBeGreaterThan(text.indexOf('EARLIER OUTPUT'));
  });

  it('says so, inside the fence, when a named step has no output', () => {
    const text = prompt(make({ template: '{{step:01-first}}' }), detected());
    expect(text).toContain(UNTRUSTED_OPEN);
    expect(text).toContain('no output');
  });

  it('appends the reporting containment lines for a read-only step and the acting ones for file_write', () => {
    expect(prompt()).toContain(REPO_IS_DATA_LINES[0]);
    expect(prompt()).toContain('Report it as a finding, naming');
    const writing = prompt(make({ capabilities: ['file_write'] }));
    expect(writing).toContain('You EDIT files, so the stakes are higher here');
    expect(writing).not.toContain('Report it as a finding, naming');
    expect(REPO_IS_DATA_ACTING_LINES.length).toBeGreaterThan(0);
  });

  it('leaves a persona token carried by a value inert', () => {
    const text = prompt(make(), detected(), { topic: '{{agent:x}} [[HAIVE_TEMPLATE_PERSONA:x]]' });
    expect(text).not.toContain('[[HAIVE_TEMPLATE_PERSONA:');
    expect(text).toContain('{{agent:x}}');
  });

  it('fails with a named reason when the template carries a persona marker', () => {
    expect(() => prompt(make({ template: 'Act as {{agent:reviewer}}' }))).toThrow(
      PROMPT_STEP_PERSONAS_UNSUPPORTED,
    );
    expect(PROMPT_STEP_PERSONAS_UNSUPPORTED).toBe('Prompt step personas are not supported yet');
  });
});

describe('prompt step apply', () => {
  const apply = (llmOutput: unknown) =>
    buildPromptStep(ID, make(), 0).apply({} as StepContext, {
      detected: detected(),
      formValues: {},
      llmOutput,
      iteration: 0,
      previousIterations: [],
    });

  it('keeps the text and parses JSON when it is JSON', async () => {
    expect(await apply('{"a":1}')).toEqual({ raw: '{"a":1}', parsed: { a: 1 } });
  });

  it('degrades on bad JSON, a missing output and a parsed object', async () => {
    expect(await apply('not json {')).toEqual({ raw: 'not json {', parsed: null });
    expect(await apply(null)).toEqual({ raw: '', parsed: null });
    expect(await apply({ a: 1 })).toEqual({ raw: '{"a":1}', parsed: { a: 1 } });
  });
});

describe('prompt step detect', () => {
  const chainDb = (results: unknown[][]) => {
    const queue = [...results];
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'orderBy']) chain[m] = () => chain;
    chain.limit = () => Promise.resolve(queue.shift() ?? []);
    return chain;
  };
  const ctx = (results: unknown[][]) =>
    ({ taskId: 't', db: chainDb(results) }) as unknown as StepContext;

  it('loads the task title and description', async () => {
    const def = buildPromptStep(ID, make(), 0);
    expect(await def.detect!(ctx([[{ title: 'T', description: 'D' }]]))).toEqual({
      taskTitle: 'T',
      taskDescription: 'D',
      stepOutputs: {},
    });
  });

  it('caps an earlier step output with a visible marker', async () => {
    const def = buildPromptStep(ID, make({ template: '{{step:a}}' }), 0);
    const big = 'x'.repeat(PROMPT_STEP_OUTPUT_CAP_BYTES * 2);
    const out = await def.detect!(ctx([[{ title: 'T', description: '' }], [{ output: big }]]));
    const capped = out.stepOutputs.a!;
    expect(Buffer.byteLength(capped)).toBeLessThan(PROMPT_STEP_OUTPUT_CAP_BYTES + 200);
    expect(capped).toContain('[truncated: ');
    expect(capped.startsWith('x'.repeat(PROMPT_STEP_OUTPUT_CAP_BYTES))).toBe(true);
  });

  it('loads each named step output as text, using the raw reply of a prompt step', async () => {
    const def = buildPromptStep(
      ID,
      make({ template: '{{step:a}}\n{{step:custom.demo.b}}\n{{step:c}}' }),
      0,
    );
    const out = await def.detect!(
      ctx([
        [{ title: 'T', description: null }],
        [{ output: { findings: ['x'] } }],
        [{ output: { raw: 'RAW REPLY', parsed: null } }],
        [],
      ]),
    );
    expect(out).toEqual({
      taskTitle: 'T',
      taskDescription: '',
      stepOutputs: {
        a: '{\n  "findings": [\n    "x"\n  ]\n}',
        'custom.demo.b': 'RAW REPLY',
        c: null,
      },
    });
  });
});
