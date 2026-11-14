// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { TaskTestsTimeCell } from '../src/components/task-tests-time-cell';
import { summarizeTestChecks } from '@haive/shared/stats';

afterEach(cleanup);
it('adds measured suite time and incomplete counts to the tooltip', () => {
  const testChecks = summarizeTestChecks([
    {
      taskId: 't',
      slot: 'test',
      outcome: 'passed',
      startedAt: new Date(0),
      endedAt: new Date(2000),
    },
    { taskId: 't', slot: 'test', outcome: 'running', startedAt: new Date(0), endedAt: null },
  ]);
  render(
    <TaskTestsTimeCell
      steps={[
        {
          stepId: '08-phase-5-verify',
          status: 'done',
          startedAt: new Date(0),
          endedAt: new Date(3000),
          idleMs: 0,
          userActiveMs: 0,
          waitingStartedAt: null,
        },
      ]}
      nowMs={3000}
      format={(ms) => `${ms}ms`}
      testChecks={testChecks}
    />,
  );
  const title = screen.getByText('tests').parentElement?.title;
  expect(title).toContain('suite: 2000ms');
  expect(title).toContain('1 incomplete');
});
it('shows current and carried test-phase work as part of work, excluding review', () => {
  const base = {
    startedAt: new Date(0),
    endedAt: new Date(1000),
    idleMs: 100,
    userActiveMs: 0,
    waitingStartedAt: null,
    status: 'done',
    carriedWorkMs: 200,
  };
  render(
    <TaskTestsTimeCell
      steps={[
        { ...base, stepId: '08-phase-5-verify' },
        { ...base, stepId: '08c-code-review' },
      ]}
      nowMs={1000}
      format={(ms) => `${ms}ms`}
    />,
  );
  expect(screen.getByText('1100ms')).toBeTruthy();
  expect(screen.getByText('tests').parentElement?.title).toContain('part of work');
});
it('renders a measured zero without hiding the cell', () => {
  render(
    <TaskTestsTimeCell
      steps={[
        {
          stepId: '08-phase-5-verify',
          status: 'done',
          startedAt: new Date(0),
          endedAt: new Date(0),
          idleMs: 0,
          userActiveMs: 0,
          waitingStartedAt: null,
        },
      ]}
      nowMs={1000}
      format={(ms) => `${ms}ms`}
    />,
  );
  expect(screen.getByText('0ms')).toBeTruthy();
});

it('shows no tests cell when the task type has no test-phase step', () => {
  const { container } = render(
    <TaskTestsTimeCell
      steps={[
        {
          stepId: '00-onboarding',
          status: 'done',
          startedAt: new Date(0),
          endedAt: new Date(1000),
          idleMs: 0,
          userActiveMs: 0,
          waitingStartedAt: null,
        },
      ]}
      nowMs={1000}
      format={(ms) => `${ms}ms`}
    />,
  );
  expect(container.textContent).toBe('');
});
