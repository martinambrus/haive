// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  SPEC_ROLES,
  STEP_ROLE_REGISTRY,
  CODE_REVIEW_OUTPUT_CONTRACT,
} from '@haive/shared/step-outputs';
import { projectStepPorts, dataRoleDraftIssues } from '@haive/shared/step-ports';
import type { TaskTypeCatalog, AdminTaskType } from '@/lib/api-client';
import { derivedFixture } from '@/lib/derived-test-fixture';
import { TaskTypeEditor } from './task-type-editor';

const mocks = vi.hoisted(() => ({
  getTaskTypeCatalog: vi.fn(),
  getAdminTaskType: vi.fn(),
  previewDerivedTaskType: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
}));
vi.mock('@/lib/api-client', async (original) => ({
  ...(await original<typeof import('@/lib/api-client')>()),
  ...mocks,
  api: { get: mocks.get, post: mocks.post },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/use-page-title', () => ({ usePageTitle: () => {} }));
vi.mock('@/lib/use-unsaved-changes-guard', () => ({ useUnsavedChangesGuard: () => null }));
vi.mock('@/lib/use-composer-integrations', () => ({
  useComposerIntegrations: () => ({
    info: { categories: [], status: 'current', providers: [], modules: [] },
    refresh: vi.fn(),
  }),
}));
vi.mock('./task-type-creator-panel', () => ({
  TaskTypeCreatorPanel: () => null,
  forgetDraftConversation: vi.fn(),
}));
vi.mock('next/dynamic', () => ({
  default:
    () =>
    ({ graph }: { graph: unknown }) => <pre aria-label="Canvas graph">{JSON.stringify(graph)}</pre>,
}));
const role = SPEC_ROLES.checked;
const producer = '05-phase-0b5-spec-quality';
const consumer = 'module.ports.use';
const input = { input: 'spec', role, contract: STEP_ROLE_REGISTRY[role].contract, optional: false };
const entry = (stepId: string) => ({
  stepId,
  label: `Title ${stepId}`,
  group: 'test',
  dispatchesCli: false,
  requires: [],
  provides: [],
});
function setup() {
  const ids = [producer, consumer];
  const entries = ids.map((id) => ({
    ...entry(id),
    ...(id === consumer ? { consumesRoles: [input] } : {}),
  }));
  const catalog: TaskTypeCatalog = {
    synced: true,
    modules: [],
    groups: [{ id: 'test', label: 'Test' }],
    registeredStepIds: ids,
    steps: entries.map((e) => ({ stepId: e.stepId, title: e.label, source: 'builtin', entry: e })),
  };
  const row = {
    slug: 'mine',
    displayName: 'Mine',
    source: 'admin',
    runListStrategy: 'static',
    stepIds: ids,
    requiresRepository: false,
    promptSteps: {},
    stepLoopLimitDefaults: {},
    preAnswerDefaults: {},
    enabled: true,
    selectable: true,
    sortOrder: 0,
    updatedAt: '2026-11-14T00:00:00Z',
    editableFields: ['displayName', 'stepIds', 'dataRoleBindings'],
    dataRoleBindings: [
      { executionPath: null, consumerStepId: consumer, input: 'spec', producerStepId: producer },
    ],
  } as AdminTaskType;
  return { catalog, row };
}
async function mount(catalog: TaskTypeCatalog, row: AdminTaskType) {
  mocks.getTaskTypeCatalog.mockResolvedValue(catalog);
  mocks.getAdminTaskType.mockResolvedValue({ taskType: row, availability: { available: true } });
  render(<TaskTypeEditor slug="mine" />);
  await act(async () => {});
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ customEnabled: true });
  mocks.post.mockResolvedValue({ candidates: [] });
  mocks.previewDerivedTaskType.mockResolvedValue({
    candidates: [],
    issues: [],
    warnings: [],
    defaultIssues: [],
  });
});
afterEach(cleanup);

it.each(['input removed', 'module deactivated', 'input redeclared', 'declaration malformed'])(
  'keeps the editor usable with a stale binding: %s',
  async (change) => {
    const { catalog, row } = setup();
    if (change === 'module deactivated')
      catalog.steps = catalog.steps.filter((s) => s.stepId !== consumer);
    else {
      const declaration = catalog.steps[1]!.entry;
      if (change === 'input removed') declaration.consumesRoles = [];
      if (change === 'input redeclared')
        declaration.consumesRoles = [{ ...input, input: 'renamed' }];
      if (change === 'declaration malformed')
        // Simulate malformed catalog JSON outside the validated contract type.
        declaration.consumesRoles = [
          { ...input, contract: { ...input.contract, version: 99 } } as unknown as typeof input,
        ];
    }
    await mount(catalog, row);
    expect(screen.getByRole('alert').textContent).toContain(
      'invalid declarations or producer choice',
    );
    expect(screen.getByLabelText('Selected input bindings')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear binding' }));
    expect(screen.queryByLabelText('Selected input bindings')).toBeNull();
    expect(screen.getByLabelText('Step view')).toBeTruthy();
  },
);
it('keeps server graph labels and issues for an unbound draft', async () => {
  const { catalog, row } = setup();
  row.dataRoleBindings = [];
  const graph = projectStepPorts(row.stepIds!, {
    declarations: new Map(catalog.steps.map((s) => [s.stepId, s.entry])),
    labels: new Map(catalog.steps.map((s) => [s.stepId, s.title])),
  });
  // Preserve the server's diagnostic even if a local graph would choose a producer.
  graph.nodes[1]!.inputs[0]!.state = 'dangling';
  mocks.post.mockResolvedValue({ candidates: [{ executionPath: null, graph }] });
  await mount(catalog, row);
  fireEvent.click(screen.getByRole('button', { name: 'Canvas' }));
  await act(async () => {});
  expect(mocks.post).toHaveBeenCalled();
  expect(JSON.parse(screen.getByLabelText('Canvas graph').textContent!)).toEqual(graph);
});
it('uses catalog titles for a bound draft in both canvas and list', async () => {
  const { catalog, row } = setup();
  await mount(catalog, row);
  expect(
    within(screen.getByLabelText('Input bindings')).getByText(/Title module.ports.use/),
  ).toBeTruthy();
  expect(screen.getByRole('option', { name: `Title ${producer}` })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Canvas' }));
  const graph = JSON.parse(screen.getByLabelText('Canvas graph').textContent!);
  expect(graph.nodes.map((n: { label: string }) => n.label)).toEqual(
    catalog.steps.map((s) => s.title),
  );
});
it('projects a derived candidate with its v2 host-policy occupant and inherited spec inputs', async () => {
  const { catalog, row } = setup();
  const prefix = derivedFixture().candidates[0]!.stepIds.slice(0, 3);
  const review = '08c-code-review';
  const replacement = 'module.ports.review';
  const reviewEntry = {
    ...entry(review),
    provides: ['review'],
    outputContract: CODE_REVIEW_OUTPUT_CONTRACT,
  };
  catalog.steps.push(
    ...prefix.map((id) => ({ stepId: id, title: id, source: 'builtin', entry: entry(id) })),
    { stepId: review, title: 'Review', source: 'builtin', entry: reviewEntry },
    {
      stepId: replacement,
      title: 'Replacement review',
      source: 'module:ports',
      entry: {
        ...reviewEntry,
        stepId: replacement,
        label: 'Replacement review',
        replaces: [review],
      },
    },
  );
  catalog.registeredStepIds = catalog.steps.map((s) => s.stepId);
  catalog.bases = [
    {
      slug: 'workflow',
      eligibility: { eligible: true },
      orderedBaseLists: [{ executionPath: null, stepIds: [...prefix, producer, review, consumer] }],
    },
  ];
  Object.assign(row, {
    runListStrategy: 'derived',
    baseSlug: 'workflow',
    changes: [{ replace: review, with: replacement }],
    stepIds: null,
    dataRoleBindings: [
      {
        executionPath: null,
        consumerStepId: replacement,
        input: 'checked',
        producerStepId: producer,
      },
    ],
  });
  await mount(catalog, row);
  // A missing v2 binding would make this saved input look undeclared and would crash render.
  const select = screen.getByLabelText(`${replacement}.checked producer`) as HTMLSelectElement;
  expect(select.value).toBe(producer);
  fireEvent.click(screen.getByRole('button', { name: 'Canvas' }));
  const graph = JSON.parse(screen.getByLabelText('Canvas graph').textContent!);
  expect(graph.nodes.find((n: { id: string }) => n.id === replacement).outputs).toEqual(
    expect.arrayContaining([expect.objectContaining({ role: review })]),
  );
  const candidates = [
    {
      executionPath: null,
      stepIds: [...prefix, producer, replacement, consumer],
      roleBindings: {
        [review]: { stepId: replacement, outputContract: CODE_REVIEW_OUTPUT_CONTRACT },
      },
    },
  ];
  expect(
    dataRoleDraftIssues(
      candidates,
      new Map(catalog.steps.map((s) => [s.stepId, s.entry])),
      row.dataRoleBindings!,
    ),
  ).toEqual([]);
});
