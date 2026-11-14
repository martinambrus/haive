// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { TaskTestsTimeCell } from '../src/components/task-tests-time-cell';

afterEach(cleanup);
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
  render(<TaskTestsTimeCell steps={[]} nowMs={1000} format={(ms) => `${ms}ms`} />);
  expect(screen.getByText('0ms')).toBeTruthy();
});
