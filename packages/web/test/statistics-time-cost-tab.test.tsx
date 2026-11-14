// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { HostApi } from '@haive/web-kit/host';
import { StatsPage } from '../../../modules/statistics/src/web/stats-page';
import { TimeCostReport } from '../../../modules/statistics/src/web/components/time-cost-report';
import { buildTimeCostReport } from '@haive/shared/stats';

const h = vi.hoisted(() => ({ search: 'preset=7d&tab=plan', replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: h.replace }),
  useSearchParams: () => new URLSearchParams(h.search),
}));
vi.mock('@haive/web-kit/use-page-title', () => ({ usePageTitle: () => undefined }));
vi.mock('next/dynamic', () => ({
  default: () => (props: { report?: { marker: string } }) =>
    props.report ? <div data-testid="report">{props.report.marker}</div> : null,
}));
afterEach(() => {
  cleanup();
  h.search = 'preset=7d&tab=plan';
  h.replace.mockReset();
});

it('shows absent task timing as unmeasured even though summary reconciliation totals are zero', () => {
  const report = buildTimeCostReport({
    tasks: [{ taskId: 't', completedAt: new Date(1000) }],
    steps: [],
    events: [],
    invocations: [],
  });
  render(
    <TimeCostReport
      report={{
        ...report,
        rows: report.rows.map((r) => ({ ...r, title: 'Historical task', repository: null })),
        excludedLegacyInvocations: 0,
        scope: { providerIgnored: false },
        costDisplay: { currency: 'USD', usdPerUnit: 1, rateDate: null, approximate: false },
      }}
    />,
  );
  expect(screen.getAllByText('Workflow work')[0]!.nextElementSibling?.textContent).toBe('—');
  expect(screen.getAllByText('Human active')[0]!.nextElementSibling?.textContent).toBe('—');
});

it('loads only when opened, carries the filters and rejects an old window response', async () => {
  let finishOld!: (value: unknown) => void;
  const get = vi.fn(async (path: string): Promise<unknown> => {
    if (path === '/user-settings/ui-prefs') return { settingsJson: '{}' };
    if (path === '/repos') return { repositories: [] };
    if (path.includes('/settings/')) return { values: {} };
    if (path.includes('/time-cost'))
      return path.includes('repositoryId=repo2')
        ? { marker: 'new window' }
        : new Promise((resolve) => {
            finishOld = resolve;
          });
    return null;
  });
  const api = { get } as unknown as HostApi;
  const view = render(<StatsPage moduleId="statistics" path={[]} api={api} />);
  await waitFor(() =>
    expect(get.mock.calls.some(([path]) => path.includes('/summary'))).toBe(true),
  );
  expect(get.mock.calls.some(([path]) => path.includes('/time-cost'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Time & cost report' }));
  expect(h.replace.mock.calls[0]?.[0]).toContain('tab=report');
  h.search = 'preset=7d&tab=report';
  view.rerender(<StatsPage moduleId="statistics" path={[]} api={api} />);
  await waitFor(() => expect(finishOld).toBeTypeOf('function'));
  h.search += '&repositoryId=repo2';
  view.rerender(<StatsPage moduleId="statistics" path={[]} api={api} />);
  await waitFor(() => expect(screen.getByTestId('report').textContent).toBe('new window'));
  finishOld({ marker: 'old window' });
  await waitFor(() => expect(screen.getByTestId('report').textContent).toBe('new window'));
});

it('renders aggregate command coverage and preserves each mixed-population row label', () => {
  const report = buildTimeCostReport({
    tasks: ['ran', 'not_run', 'unrecorded'].map((taskId) => ({
      taskId,
      completedAt: new Date(1000),
    })),
    steps: [true, false, undefined].map((ran, i) => ({
      id: String(i),
      taskId: ['ran', 'not_run', 'unrecorded'][i]!,
      stepId: '08-phase-5-verify',
      status: 'done',
      startedAt: new Date(0),
      endedAt: new Date(1000),
      idleMs: 0,
      userActiveMs: 0,
      waitingStartedAt: null,
      output: { test: { ran } },
    })),
    events: [],
    invocations: [],
  });
  render(
    <TimeCostReport
      report={{
        ...report,
        rows: report.rows.map((r) => ({ ...r, title: r.taskId, repository: null })),
        excludedLegacyInvocations: 0,
        scope: { providerIgnored: false },
        costDisplay: { currency: 'USD', usdPerUnit: 1, rateDate: null, approximate: false },
      }}
    />,
  );
  expect(
    screen.getByText('1 of 3 tasks ran a test command · 1 not run · 1 execution not recorded'),
  ).toBeTruthy();
  for (const label of ['command ran', 'not run', 'execution not recorded'])
    expect(screen.getByText('1s · ' + label)).toBeTruthy();
});
