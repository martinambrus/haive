// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliInvocationSummary } from '@/lib/api-client';
import { StepTerminal } from './StepTerminal';

const h = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ api: { get: h.get } }));
vi.mock('./CliStreamViewer', () => ({ CliStreamViewer: () => null }));
vi.mock('@/lib/use-global-pause', () => ({ useGlobalPause: () => false }));
vi.mock('@/lib/terminal-autoscroll', () => ({ useAutoScrollTerminals: () => [false, () => {}] }));
vi.mock('@/lib/terminal-autoclose', () => ({
  useAutoCloseSuccessfulTerminals: () => [false, () => {}],
}));

beforeEach(() => {
  localStorage.clear();
  h.get.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function makeInvocation(overrides: Partial<CliInvocationSummary> = {}): CliInvocationSummary {
  return {
    id: 'run',
    mode: 'cli',
    runNumber: 2,
    agentTitle: null,
    assignedAgentIds: [],
    exitCode: 0,
    durationMs: 1000,
    timeoutMs: null,
    startedAt: '2026-11-26T12:00:00Z',
    endedAt: '2026-11-26T12:00:01Z',
    createdAt: '2026-11-26T12:00:00Z',
    errorMessage: null,
    isActive: false,
    providerLabel: 'Codex',
    providerName: 'codex',
    statusMessage: null,
    tokenUsage: null,
    apiDurationMs: null,
    effort: null,
    ...overrides,
  };
}

async function show(
  agentTitle: string | null,
  assignedAgentIds: string[] = [],
  totalCount = 2,
  mode: CliInvocationSummary['mode'] = 'cli',
) {
  const invocation = makeInvocation({ agentTitle, assignedAgentIds, mode });
  h.get.mockResolvedValue({ invocations: [invocation], totalCount, historyTotal: 1 });
  await act(async () => {
    render(<StepTerminal taskId="task" stepRowId="step" autoExpand statusMessage={null} />);
  });
}

describe('step terminal run labels', () => {
  it('shows the stable run number and the existing header title once', async () => {
    await show('Review, part 3 of 12');
    expect(screen.getByText('Run 2')).toBeTruthy();
    const title = screen.getByText('Review, part 3 of 12');
    expect(title.getAttribute('title')).toBe('Review, part 3 of 12');
    expect(screen.queryByText('Run 2 · Review, part 3 of 12')).toBeNull();
  });

  it.each([
    { mode: 'agent_mining' as const, title: 'Refuter 2/4 [reachability] · issue' },
    { mode: 'cli' as const, title: 'Validator' },
    { mode: 'cli' as const, title: 'Fixer' },
    { mode: 'cli' as const, title: 'Review pass 3' },
  ])('preserves the separate $title header after the persona badge', async ({ mode, title }) => {
    await show(title, ['security-reviewer'], 2, mode);
    expect(screen.getByText('Run 2')).toBeTruthy();
    const headerTitle = screen.getByText(title);
    expect(headerTitle.classList.contains('text-indigo-300')).toBe(true);
    expect(headerTitle.getAttribute('title')).toBe(title);
    expect(
      screen
        .getByLabelText('Agent personality: security-reviewer')
        .compareDocumentPosition(headerTitle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText(`Run 2 · ${title}`)).toBeNull();
  });

  it('keeps untitled run labels unchanged', async () => {
    await show(null);
    expect(screen.getByText('Run 2')).toBeTruthy();
  });

  it('retains the title for a single run', async () => {
    await show('Translate (accuracy)', [], 1);
    expect(screen.getByText('Translate (accuracy)')).toBeTruthy();
    expect(screen.queryByText(/Run 2/)).toBeNull();
  });

  it('suppresses a title that repeats an assigned persona', async () => {
    await show('Security Reviewer', ['security-reviewer']);
    expect(screen.getByText('Run 2')).toBeTruthy();
    expect(screen.getByLabelText('Agent personality: security-reviewer')).toBeTruthy();
    expect(screen.queryByText(/Security Reviewer/)).toBeNull();
  });

  it('truncates a long title with the full text available on hover', async () => {
    const title = 'Review '.repeat(35).trim();
    await show(title);
    const label = screen.getByTitle(title);
    expect(label.classList.contains('truncate')).toBe(true);
    expect(label.classList.contains('max-w-full')).toBe(true);
  });

  it('renders a title as literal text', async () => {
    await show('<b>Review</b> **part 3**');
    const label = screen.getByText('<b>Review</b> **part 3**');
    expect(label.querySelector('b, strong')).toBeNull();
  });
});

describe('collapsed step terminal live count', () => {
  beforeEach(() => vi.useFakeTimers());

  async function showRunning() {
    const running = makeInvocation({ isActive: true, endedAt: null, exitCode: null });
    h.get.mockResolvedValue({ invocations: [running], totalCount: 1, historyTotal: 0 });
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(
        <StepTerminal taskId="task" stepRowId="step" autoExpand statusMessage={null} />,
      );
    });
    expect(screen.getByRole('button', { name: /Hide terminal/ }).textContent).toContain(
      '1 run · 1 live',
    );
    return view;
  }

  function endRun() {
    h.get.mockResolvedValue({ invocations: [makeInvocation()], totalCount: 1, historyTotal: 1 });
  }

  async function expectNoPolling() {
    const calls = h.get.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(h.get).toHaveBeenCalledTimes(calls);
  }

  it('drops live from the collapsed header when the step goes idle', async () => {
    const view = await showRunning();
    endRun();
    await act(async () => {
      view.rerender(
        <StepTerminal taskId="task" stepRowId="step" autoExpand={false} statusMessage={null} />,
      );
    });
    expect(screen.getByRole('button', { name: /Show terminal/ }).textContent).toContain('1 run');
    expect(screen.queryByText(/live/)).toBeNull();
    expect(h.get).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem('task-ui:task:term:step')).toBeNull();
    await expectNoPolling();
  });

  it('refreshes once on manual collapse and again on idle if the run was still active', async () => {
    const view = await showRunning();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Hide terminal/ }));
    });
    expect(h.get).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: /Show terminal/ }).textContent).toContain('1 live');
    await expectNoPolling();

    endRun();
    await act(async () => {
      view.rerender(
        <StepTerminal taskId="task" stepRowId="step" autoExpand={false} statusMessage={null} />,
      );
    });
    expect(screen.queryByText(/live/)).toBeNull();
    expect(h.get).toHaveBeenCalledTimes(3);
    expect(localStorage.getItem('task-ui:task:term:step')).toBe('0');
    await expectNoPolling();
  });

  it('does not fetch or poll an idle panel mounted collapsed without loaded runs', async () => {
    await act(async () => {
      render(
        <StepTerminal taskId="task" stepRowId="step" autoExpand={false} statusMessage={null} />,
      );
    });
    expect(h.get).not.toHaveBeenCalled();
    await expectNoPolling();
  });
});
