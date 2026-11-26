// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StepRagStatsToggle } from '../src/components/step-rag-stats-toggle';
import { stepRagStatsState } from '../src/lib/step-banners';

afterEach(cleanup);
const base = { cliInvocationCount: 1, startedAt: '2026-11-26T12:00:00Z', ragQueryCount: 0 };

it.each(['done', 'failed', 'skipped'])(
  'renders aligned muted info for a finished %s step with no queries',
  (status) => {
    render(
      <StepRagStatsToggle
        state={stepRagStatsState({ ...base, status })}
        expanded={true}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    const info = screen.getByText('No RAG used');
    expect(info.className).toContain('self-start');
    expect(info.className).toContain('text-neutral-400');
  },
);

it.each(['done', 'failed', 'running', 'waiting_cli'])(
  'keeps the toggle for a %s step with queries',
  (status) => {
    const onToggle = vi.fn();
    render(
      <StepRagStatsToggle
        state={stepRagStatsState({ ...base, status, ragQueryCount: 2 })}
        expanded={false}
        onToggle={onToggle}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show RAG stats' }));
    expect(onToggle).toHaveBeenCalledOnce();
  },
);

it.each(['running', 'waiting_cli', 'waiting_form', 'pending'])(
  'keeps today’s link for an unfinished %s step with no queries',
  (status) => {
    render(
      <StepRagStatsToggle
        state={stepRagStatsState({ ...base, status })}
        expanded={false}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Show RAG stats' })).toBeTruthy();
  },
);

it('renders Hide when the query panel is open', () => {
  render(
    <StepRagStatsToggle
      state={stepRagStatsState({ ...base, status: 'done', ragQueryCount: 1 })}
      expanded={true}
      onToggle={vi.fn()}
    />,
  );
  expect(screen.getByRole('button', { name: 'Hide RAG stats' })).toBeTruthy();
});

it.each([{ cliInvocationCount: 0 }, { startedAt: null }])(
  'keeps steps without a started agent out of the toggle area: %j',
  (overrides) => {
    render(
      <StepRagStatsToggle
        state={stepRagStatsState({ ...base, status: 'done', ...overrides })}
        expanded={true}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText('No RAG used')).toBeNull();
  },
);
