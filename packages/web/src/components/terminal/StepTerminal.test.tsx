// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
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
afterEach(cleanup);

async function show(agentTitle: string | null, assignedAgentIds: string[] = [], totalCount = 2) {
  const invocation: CliInvocationSummary = {
    id: 'run',
    mode: 'cli',
    runNumber: 2,
    agentTitle,
    assignedAgentIds,
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
  };
  h.get.mockResolvedValue({ invocations: [invocation], totalCount, historyTotal: 1 });
  await act(async () => {
    render(<StepTerminal taskId="task" stepRowId="step" autoExpand statusMessage={null} />);
  });
}

describe('step terminal run labels', () => {
  it('combines the stable run number and title once', async () => {
    await show('Review, part 3 of 12');
    const label = screen.getByText('Run 2 · Review, part 3 of 12');
    expect(label.getAttribute('title')).toBe('Run 2 · Review, part 3 of 12');
    expect(screen.queryByText('Review, part 3 of 12')).toBeNull();
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
    const label = screen.getByTitle(`Run 2 · ${title}`);
    expect(label.classList.contains('truncate')).toBe(true);
    expect(label.classList.contains('max-w-full')).toBe(true);
  });

  it('renders a title as literal text', async () => {
    await show('<b>Review</b> **part 3**');
    const label = screen.getByText('Run 2 · <b>Review</b> **part 3**');
    expect(label.querySelector('b, strong')).toBeNull();
  });
});
