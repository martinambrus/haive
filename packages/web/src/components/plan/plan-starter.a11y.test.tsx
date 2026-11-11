// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PlanStarter } from './plan-starter';
const net = vi.hoisted(() => ({ build: vi.fn(), upload: vi.fn() }));
vi.mock('@/lib/api-client', async (original) => ({
  ...(await original<typeof import('@/lib/api-client')>()),
  api: {
    get: async () => ({ repository: { source: 'git_https', writable: true }, providers: [] }),
  },
  getPlanBuildClis: async () => ({ plannerCliProviderId: null, questionerCliProviderId: null }),
  buildPlan: net.build,
  uploadTaskAttachment: net.upload,
  startTask: async () => ({ started: true }),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it('12 names project, attachment and root fields and announces upload progress', async () => {
  let finish!: (value: { taskId: string }) => void;
  net.build.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  net.upload.mockImplementation(() => new Promise(() => {}));
  render(
    <PlanStarter repositoryId="r" onboarded onNavigate={() => {}} onCreateRoot={async () => {}} />,
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'Project description' }), {
    target: { value: 'A club website' },
  });
  expect(screen.getByRole('textbox', { name: 'Root title' })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Attach files'), {
    target: { files: [new File(['data'], 'brief.md')] },
  });
  expect(await screen.findByRole('textbox', { name: 'Description for brief.md' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Draft a plan from this' }));
  await waitFor(() =>
    expect(screen.getAllByRole('status').some((el) => el.textContent?.includes('Creating'))).toBe(
      true,
    ),
  );
  finish({ taskId: 'draft' });
  await waitFor(() =>
    expect(screen.getAllByRole('status').some((el) => within(el).queryByText('Uploading…'))).toBe(
      true,
    ),
  );
});
