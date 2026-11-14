// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { derivedFixture } from '@/lib/derived-test-fixture';
import { TaskTypeEditor } from './task-type-editor';
import TaskTypesPage from '@/app/(app)/admin/task-types/page';
import { DerivedTaskTypeChanges } from './derived-task-type-changes';
import { MAX_DERIVED_CHANGES } from '@haive/shared/modularity';
import { evaluateDerivedEditor } from '@/lib/derived-task-type-form';

const mocks = vi.hoisted(() => ({
  getTaskTypeCatalog: vi.fn(),
  listAdminTaskTypes: vi.fn(),
  getAdminTaskType: vi.fn(),
  previewDerivedTaskType: vi.fn(),
  createTaskType: vi.fn(),
  updateTaskType: vi.fn(),
  push: vi.fn(),
}));
vi.mock('@/lib/api-client', async (original) => ({
  ...(await original<typeof import('@/lib/api-client')>()),
  ...mocks,
  api: { get: vi.fn().mockResolvedValue({ customEnabled: true }) },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/lib/use-page-title', () => ({ usePageTitle: () => {} }));
vi.mock('@/lib/use-unsaved-changes-guard', () => ({ useUnsavedChangesGuard: () => null }));
vi.mock('@/lib/use-composer-integrations', () => ({
  useComposerIntegrations: () => ({
    info: { categories: [], status: 'current', providers: [], modules: [] },
    refresh: vi.fn(),
  }),
}));
vi.mock('./task-type-creator-panel', () => ({
  TaskTypeCreatorPanel: () => <div>Static creator</div>,
  forgetDraftConversation: vi.fn(),
}));
const fixture = derivedFixture();
const base = {
  slug: 'workflow',
  displayName: 'Workflow',
  description: 'Base description',
  source: 'builtin',
  runListStrategy: 'workflow_paths',
  requiresRepository: true,
  stepIds: null,
  stepLoopLimitDefaults: {},
  preAnswerDefaults: {},
  promptSteps: {},
  enabled: true,
  selectable: true,
  sortOrder: 0,
  updatedAt: '2026-11-14T00:00:00Z',
  editableFields: ['displayName', 'description', 'sortOrder'],
};
const row = {
  ...base,
  slug: 'mine',
  displayName: 'Mine',
  source: 'admin',
  runListStrategy: 'derived',
  baseSlug: 'workflow',
  changes: [],
  editableFields: [
    'displayName',
    'description',
    'changes',
    'promptSteps',
    'stepLoopLimitDefaults',
    'preAnswerDefaults',
  ],
};
const preview = {
  candidates: fixture.candidates.map((c) => ({ ...c, outcomes: [], compositionIssues: [] })),
  issues: [],
  defaultIssues: [],
  warnings: [],
  eligibility: { eligible: true },
  revision: null,
  catalogFingerprint: 'one',
};
async function mount(props = { slug: null as string | null, duplicateBaseSlug: 'workflow' }) {
  render(<TaskTypeEditor {...props} />);
  await act(async () => {});
}
async function advance() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(350);
  });
}
function wireResponse(body: unknown) {
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(body)));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.updateTaskType.mockReset();
  mocks.getTaskTypeCatalog.mockResolvedValue(fixture.catalog);
  mocks.getAdminTaskType.mockImplementation((slug: string) =>
    Promise.resolve({
      taskType: slug === 'mine' ? row : base,
      availability: { available: true },
      diagnostics: preview,
    }),
  );
  mocks.previewDerivedTaskType.mockResolvedValue(preview);
  mocks.createTaskType.mockResolvedValue({ taskType: row });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('derived editor', () => {
  it('bounds new operations using an injected small limit', () => {
    expect(MAX_DERIVED_CHANGES).toBe(64);
    const evaluation = evaluateDerivedEditor({
      catalog: fixture.catalog,
      baseSlug: 'workflow',
      changes: [{ remove: 'old-name' }],
      typeSlug: 'mine',
      requiresRepository: true,
      promptSteps: {},
      loopLimits: {},
      preAnswerDefaults: {},
    });
    render(
      <DerivedTaskTypeChanges
        changes={[{ remove: 'old-name' }]}
        evaluation={evaluation}
        diagnostics={null}
        serverIssues={[]}
        error={null}
        disabled={false}
        editable
        revision={0}
        entries={new Map(fixture.catalog.steps.map((s) => [s.stepId, s.entry]))}
        requiresRepository
        onChange={vi.fn()}
        maxChanges={1}
      />,
    );
    expect((screen.getByRole('button', { name: 'Add change' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
  it('edits change rows live without an Apply change submit control', async () => {
    await mount({ slug: 'mine', duplicateBaseSlug: '' });
    fireEvent.click(screen.getByRole('button', { name: 'Add change' }));
    expect(screen.queryByRole('button', { name: 'Apply change' })).toBeNull();
    fireEvent.change(screen.getByLabelText(/^Target step/), { target: { value: 'old-name' } });
    expect(
      within(screen.getByRole('region', { name: 'Stale targets' })).getByText(
        /old-name: Base no longer includes this step/,
      ),
    ).toBeTruthy();
  });

  it('reads admin-list warnings from the API diagnostics envelope', async () => {
    mocks.listAdminTaskTypes.mockResolvedValue({
      taskTypes: [
        {
          ...row,
          builtin: false,
          taskCount: 0,
          availability: { available: true },
          diagnostics: {
            ...preview,
            warnings: [
              { kind: 'stale-target', operationIndex: 0, stepId: 'old-name', candidates: [null] },
            ],
          },
        },
      ],
    });
    render(<TaskTypesPage />);
    await act(async () => {});
    expect(screen.getByText(/Base no longer includes this step/)).toBeTruthy();
  });
  it('duplicates into unsaved metadata with a blank slug and no creator or write', async () => {
    await mount();
    expect((screen.getByLabelText(/^Slug/) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Workflow');
    expect(screen.queryByText('Static creator')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Changes' })).toBeTruthy();
    expect(mocks.createTaskType).not.toHaveBeenCalled();
    expect(mocks.updateTaskType).not.toHaveBeenCalled();
  });

  it('shows catalog eligibility and its precise disabled reason', async () => {
    await mount({ slug: 'workflow', duplicateBaseSlug: '' });
    expect(screen.getByRole('link', { name: 'Duplicate and customize' }).getAttribute('href')).toBe(
      '/admin/task-types/new?base=workflow',
    );
    cleanup();
    mocks.getAdminTaskType.mockResolvedValue({
      taskType: { ...base, slug: 'run_app' },
      availability: { available: true },
    });
    await mount({ slug: 'run_app', duplicateBaseSlug: '' });
    expect(
      (screen.getByRole('button', { name: 'Duplicate and customize' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText('Runtime mode is chosen after creation.')).toBeTruthy();
  });

  it('debounces preview, discards stale replies and preserves incomplete rows and unsaved text', async () => {
    let first!: (value: typeof preview) => void;
    mocks.previewDerivedTaskType.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          first = resolve;
        }),
    );
    await mount({ slug: 'mine', duplicateBaseSlug: '' });
    expect(mocks.previewDerivedTaskType).not.toHaveBeenCalled();
    await advance();
    fireEvent.click(screen.getByRole('button', { name: 'Add change' }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Unsaved' } });
    await act(async () => {
      first({ ...preview, issues: [{ kind: 'obsolete-reply' }] } as typeof preview);
    });
    expect(screen.queryByText(/obsolete-reply/)).toBeNull();
    expect(screen.getByLabelText(/^Target step/)).toBeTruthy();
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Unsaved');
    expect(screen.getByText(/invalid-derived-changes/)).toBeTruthy();
  });

  it('separates path skips from stale targets and sends only the overlay', async () => {
    const actualApi = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
    mocks.updateTaskType.mockImplementation(actualApi.updateTaskType);
    const fetch = wireResponse({
      taskType: { ...row, changes: [{ remove: 'b' }, { remove: 'old-name' }] },
    });
    await mount({ slug: 'mine', duplicateBaseSlug: '' });
    fireEvent.click(screen.getByRole('button', { name: 'Add change' }));
    fireEvent.change(screen.getByLabelText(/^Target step/), { target: { value: 'b' } });
    expect(
      within(screen.getByRole('region', { name: 'Skipped on path' })).getByText(/quick_bugfix/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add change' }));
    fireEvent.change(screen.getAllByLabelText(/^Target step/)[1]!, {
      target: { value: 'old-name' },
    });
    expect(
      within(screen.getByRole('region', { name: 'Stale targets' })).getAllByText(
        /Base no longer includes this step/,
      ).length,
    ).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Overlay revision' } });
    fireEvent.change(screen.getByLabelText('Loop limit'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await act(async () => {});
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${actualApi.API_BASE_URL}/admin/task-types/mine`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({
      displayName: 'Overlay revision',
      changes: [{ remove: 'b' }, { remove: 'old-name' }],
      stepLoopLimitDefaults: { a: 3 },
      expectedUpdatedAt: row.updatedAt,
    });
  });

  it('merges stale warnings by operation and lets server wording win', async () => {
    mocks.previewDerivedTaskType.mockResolvedValue({
      ...preview,
      warnings: [0, 1].map((operationIndex) => ({
        kind: 'stale-target',
        operationIndex,
        stepId: 'old-name',
        candidates: [null, 'quick_bugfix'],
      })),
    });
    await mount({ slug: 'mine', duplicateBaseSlug: '' });
    for (let index = 0; index < 2; index++) {
      fireEvent.click(screen.getByRole('button', { name: 'Add change' }));
      fireEvent.change(screen.getAllByLabelText(/^Target step/)[index]!, {
        target: { value: 'old-name' },
      });
    }
    const stale = within(screen.getByRole('region', { name: 'Stale targets' }));
    expect(stale.getAllByText(/Base no longer includes this step/)).toHaveLength(2);
    await advance();
    expect(stale.getAllByText(/Base no longer includes this step/)).toHaveLength(2);
    expect(stale.getAllByText(/Paths: pre-triage, quick_bugfix/)).toHaveLength(2);
  });

  it('makes 403 non-retryable and retains the existing 409 Reload flow', async () => {
    await mount({ slug: 'mine', duplicateBaseSlug: '' });
    mocks.updateTaskType.mockRejectedValueOnce({ status: 403, message: 'Admin access required' });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Unsaved' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await act(async () => {});
    expect(screen.getByText(/Admin access required/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    cleanup();
    await mount({ slug: 'mine', duplicateBaseSlug: '' });
    const theirs = { ...row, displayName: 'Theirs', changes: [{ remove: 'old-name' }] };
    mocks.updateTaskType.mockRejectedValueOnce({
      status: 409,
      code: 'task_type_changed',
      body: { taskType: theirs },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Theirs');
    expect((screen.getByLabelText(/^Target step/) as HTMLInputElement).value).toBe('old-name');
  });

  it('keeps static saves retryable after a 403', async () => {
    mocks.getAdminTaskType.mockResolvedValue({
      taskType: {
        ...row,
        runListStrategy: 'static',
        baseSlug: null,
        stepIds: fixture.candidates[0]!.stepIds,
      },
      availability: { available: true },
    });
    await mount({ slug: 'mine', duplicateBaseSlug: '' });
    mocks.updateTaskType.mockRejectedValueOnce({ status: 403, message: 'Static access required' });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Unsaved' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await act(async () => {});
    expect(screen.getByText('Static access required')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(mocks.previewDerivedTaskType).not.toHaveBeenCalled();
  });

  it('keeps derived permission errors visible through edits until a successful reload', async () => {
    await mount({ slug: 'mine', duplicateBaseSlug: '' });
    mocks.updateTaskType.mockRejectedValueOnce({ status: 403, message: 'Derived access required' });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await act(async () => {});
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Still unsaved' } });
    expect(screen.getByText('Derived access required')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    cleanup();
    await mount({ slug: 'mine', duplicateBaseSlug: '' });
    expect(screen.queryByText('Derived access required')).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('opens the static editor for an empty base query value', async () => {
    await mount({ slug: null, duplicateBaseSlug: '' });
    expect(screen.getByText('Static creator')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Changes' })).toBeNull();
    expect(mocks.getAdminTaskType).not.toHaveBeenCalled();
    await advance();
    expect(mocks.previewDerivedTaskType).not.toHaveBeenCalled();
  });

  it.each([
    ['06-gate-1-spec-approval', true],
    ['09-gate-2-verify-approval', true],
    ['10-gate-3-commit', true],
    ['11a-gate-4-push', true],
    ['07-phase-2-implement', true],
    ['module.example.gate-check', false],
    ['custom.mine.gate-check', false],
    ['delegate-work', false],
  ])(
    'warns about safeguard removal for %s only when it is a core safeguard',
    async (stepId, expected) => {
      await mount({ slug: 'mine', duplicateBaseSlug: '' });
      fireEvent.click(screen.getByRole('button', { name: 'Add change' }));
      fireEvent.change(screen.getByLabelText(/^Target step/), { target: { value: stepId } });
      expect(screen.queryByText(/Removing a gate or the implementation step/) !== null).toBe(
        expected,
      );
    },
  );

  it('creates an overlay with its own limits and no inherited base presets', async () => {
    const actualApi = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
    mocks.createTaskType.mockImplementation(actualApi.createTaskType);
    const fetch = wireResponse({ taskType: row });
    mocks.getAdminTaskType.mockResolvedValue({
      taskType: {
        ...base,
        stepLoopLimitDefaults: { a: 9 },
        preAnswerDefaults: { a: { depth: 9 } },
      },
      availability: { available: true },
    });
    await mount();
    fireEvent.change(screen.getByLabelText(/^Slug/), { target: { value: 'mine' } });
    fireEvent.change(screen.getByLabelText('Loop limit'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task type' }));
    await act(async () => {});
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${actualApi.API_BASE_URL}/admin/task-types`);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      slug: 'mine',
      displayName: 'Workflow',
      description: 'Base description',
      requiresRepository: true,
      enabled: true,
      selectable: true,
      sortOrder: 0,
      runListStrategy: 'derived',
      baseSlug: 'workflow',
      changes: [],
      stepLoopLimitDefaults: { a: 3 },
      preAnswerDefaults: {},
      promptSteps: {},
    });
    for (const key of ['stepIds', 'candidates', 'source', 'orderedBaseLists'])
      expect(body).not.toHaveProperty(key);
    expect(mocks.push).toHaveBeenCalledWith('/admin/task-types/mine');
  });

  it('posts only the unsaved overlay and metadata to preview after the debounce', async () => {
    const actualApi = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
    mocks.previewDerivedTaskType.mockImplementation(actualApi.previewDerivedTaskType);
    const fetch = wireResponse(preview);
    await mount({ slug: 'mine', duplicateBaseSlug: '' });
    fireEvent.click(screen.getByRole('button', { name: 'Add x' }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Unsaved preview' } });
    fireEvent.change(screen.getByLabelText('Loop limit'), { target: { value: '3' } });
    expect(fetch).not.toHaveBeenCalled();
    await advance();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${actualApi.API_BASE_URL}/admin/task-types/preview`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      slug: 'mine',
      displayName: 'Unsaved preview',
      description: 'Base description',
      requiresRepository: true,
      enabled: true,
      selectable: true,
      sortOrder: 0,
      runListStrategy: 'derived',
      baseSlug: 'workflow',
      changes: [{ insertAfter: 'b', step: 'x' }],
      stepLoopLimitDefaults: { a: 3 },
      promptSteps: {},
      preAnswerDefaults: {},
    });
    expect(mocks.createTaskType).not.toHaveBeenCalled();
    expect(mocks.updateTaskType).not.toHaveBeenCalled();
  });

  it('keeps path ordering read-only while palette actions author ordered changes', async () => {
    await mount({ slug: 'mine', duplicateBaseSlug: '' });
    expect(screen.queryByRole('button', { name: 'Move a up' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add x' }));
    expect((screen.getByLabelText(/^Operation/) as HTMLSelectElement).value).toBe('insertAfter');
    expect((screen.getByLabelText(/^Target step/) as HTMLInputElement).value).toBe('b');
    expect((screen.getByLabelText(/^New step/) as HTMLInputElement).value).toBe('x');
    fireEvent.change(screen.getByLabelText('Path preview'), { target: { value: 'quick_bugfix' } });
    expect(within(screen.getByRole('region', { name: 'Steps' })).queryByText('x')).toBeNull();
    fireEvent.change(screen.getByLabelText('Path preview'), { target: { value: 'pre-triage' } });
    expect(
      within(screen.getByRole('region', { name: 'Steps' })).getAllByText('x').length,
    ).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Add change' }));
    fireEvent.change(screen.getAllByLabelText(/^Target step/)[1]!, {
      target: { value: 'old-name' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Move change 2 up' }));
    expect((screen.getAllByLabelText(/^Target step/)[0] as HTMLInputElement).value).toBe(
      'old-name',
    );
    expect((screen.getAllByLabelText(/^New step/)[0] as HTMLInputElement).value).toBe('x');
    fireEvent.click(screen.getByRole('button', { name: 'Delete change 1' }));
    expect((screen.getByLabelText(/^Target step/) as HTMLInputElement).value).toBe('b');
  });

  it('preserves prompt authoring and clamps the shared loop control', async () => {
    await mount({ slug: 'mine', duplicateBaseSlug: '' });
    fireEvent.change(screen.getByLabelText('Loop limit'), { target: { value: '80' } });
    expect((screen.getByLabelText('Loop limit') as HTMLInputElement).value).toBe('50');
    fireEvent.click(screen.getByRole('button', { name: 'Add prompt step' }));
    expect((screen.getByLabelText(/^New step/) as HTMLInputElement).value).toBe(
      'custom.mine.prompt-step',
    );
    expect(screen.getByRole('button', { name: 'Close prompt step Prompt step' })).toBeTruthy();
    expect(screen.queryByText('Static creator')).toBeNull();
  });

  it('warns on safeguard removal while shared composition decides validity', async () => {
    await mount({ slug: 'mine', duplicateBaseSlug: '' });
    fireEvent.click(screen.getByRole('button', { name: 'Add change' }));
    fireEvent.change(screen.getByLabelText(/^Target step/), {
      target: { value: '07-phase-2-implement' },
    });
    expect(screen.getByText(/Removing a gate or the implementation step/)).toBeTruthy();
    // It is stale in this fixture; no extra editor prohibition may block the flat save.
    expect(
      (screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('allows unchanged obsolete defaults while keeping them visible', async () => {
    mocks.getAdminTaskType.mockResolvedValue({
      taskType: { ...row, stepLoopLimitDefaults: { a: 3 } },
      availability: { available: true },
    });
    await mount({ slug: 'mine', duplicateBaseSlug: '' });
    fireEvent.click(screen.getByRole('button', { name: 'Add change' }));
    fireEvent.change(screen.getByLabelText(/^Target step/), { target: { value: 'a' } });
    expect(
      (screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.getByRole('button', { name: 'Clear obsolete loop limit for a' })).toBeTruthy();
  });

  it('shows fresh authoritative save issues without replacing unsaved changes', async () => {
    await mount({ slug: 'mine', duplicateBaseSlug: '' });
    fireEvent.click(screen.getByRole('button', { name: 'Add x' }));
    mocks.updateTaskType.mockRejectedValueOnce({
      status: 400,
      message: 'Invalid derived task type',
      body: { issues: [{ kind: 'missing-installed-step', stepId: 'x' }] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await act(async () => {});
    expect(screen.getByText(/x: This step is not installed/)).toBeTruthy();
    expect((screen.getByLabelText(/^New step/) as HTMLInputElement).value).toBe('x');
  });

  it('keeps orphan prompt work repairable after its insertion is deleted', async () => {
    await mount({ slug: 'mine', duplicateBaseSlug: '' });
    fireEvent.click(screen.getByRole('button', { name: 'Add prompt step' }));
    fireEvent.change(screen.getByLabelText('Prompt template'), {
      target: { value: 'Unsaved prompt' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete change 1' }));
    expect((screen.getByLabelText('Prompt template') as HTMLTextAreaElement).value).toBe(
      'Unsaved prompt',
    );
  });
});
