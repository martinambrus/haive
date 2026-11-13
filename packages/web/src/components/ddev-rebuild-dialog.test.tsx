// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
const h = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ api: { post: h.post } }));
import { DdevRebuildDialog, canRebuildDdev } from './ddev-rebuild-dialog';
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function Fixture() {
  const [open, setOpen] = useState(true);
  const [notice, setNotice] = useState('');
  return (
    <>
      <p>{notice}</p>
      <DdevRebuildDialog
        taskId={open ? 'task' : null}
        onClose={() => setOpen(false)}
        onQueued={(message: string) => {
          setNotice(message);
          setOpen(false);
        }}
      />
    </>
  );
}
it('states removal, snapshot restoration, loss, and Retry of a failed step', () => {
  render(<Fixture />);
  const copy = screen.getByRole('alertdialog').textContent;
  expect(copy).toMatch(/runner.*removed/i);
  expect(copy).toMatch(/last snapshot.*if one exists/i);
  expect(copy).toMatch(/every change since.*lost/i);
  expect(copy).toMatch(/failed step stays failed.*Retry/i);
});
it('Escape cancels without making a request', () => {
  render(<Fixture />);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(h.post).not.toHaveBeenCalled();
});
it('only confirmation posts a rebuild', async () => {
  h.post.mockResolvedValue({ ok: true });
  render(<Fixture />);
  fireEvent.click(screen.getByRole('button', { name: 'Rebuild DDEV' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(h.post).toHaveBeenCalledWith('/tasks/task/ddev/rebuild', {});
});
it('offers the menu action from structured DDEV output only while steps are idle', () => {
  const ddev = {
    stepId: '01c-ddev-env',
    status: 'failed',
    detectOutput: { ddevConfigured: true },
    output: null,
  };
  expect(canRebuildDdev([ddev])).toBe(true);
  expect(canRebuildDdev([{ ...ddev, status: 'running' }])).toBe(false);
  expect(canRebuildDdev([{ ...ddev, status: 'waiting_cli' }])).toBe(false);
  expect(canRebuildDdev([{ ...ddev, detectOutput: null, output: { started: true } }])).toBe(true);
  expect(canRebuildDdev([{ ...ddev, detectOutput: { ddevConfigured: false } }])).toBe(false);
});

it('recognizes DDEV detected after the initial runtime step', () => {
  const step = { status: 'waiting_form', output: null };
  expect(
    canRebuildDdev([{ ...step, stepId: '08a-browser-setup', detectOutput: { ddevMode: true } }]),
  ).toBe(true);
  expect(
    canRebuildDdev([{ ...step, stepId: '99-run-app-ready', detectOutput: { mode: 'ddev' } }]),
  ).toBe(true);
  expect(
    canRebuildDdev([{ ...step, stepId: '99-run-app-ready', detectOutput: { mode: 'app-runner' } }]),
  ).toBe(false);
  expect(
    canRebuildDdev([
      {
        ...step,
        stepId: '01c-ddev-env',
        detectOutput: { ddevConfigured: false, needsConfig: true },
      },
    ]),
  ).toBe(false);
});

it.each([
  [{ ok: true }, /removed.*recovery.*queued/i],
  [{ ok: false, pending: true }, /still pending.*not.*confirmed/i],
])('shows the API rebuild outcome %j', async (reply, text) => {
  h.post.mockResolvedValueOnce(reply);
  render(<Fixture />);
  fireEvent.click(screen.getByRole('button', { name: 'Rebuild DDEV' }));
  expect(await screen.findByText(text)).toBeTruthy();
});
it.each(['busy', 'unknown Docker probe; retry', 'foreign runner', 'no DDEV runtime'])(
  'shows the API refusal: %s',
  async (reason) => {
    h.post.mockRejectedValueOnce(new Error(reason));
    render(<Fixture />);
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild DDEV' }));
    expect(await screen.findByText(reason)).toBeTruthy();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  },
);

it('points pending requests at Activity and asks the user to check again', async () => {
  h.post.mockResolvedValueOnce({ ok: false, pending: true });
  render(<Fixture />);
  fireEvent.click(screen.getByRole('button', { name: 'Rebuild DDEV' }));
  expect(await screen.findByText(/still pending.*Activity tab.*check again/i)).toBeTruthy();
  expect(screen.queryByText(/check task history/i)).toBeNull();
});
it('keeps a finished rebuild failure visible in the dialog', async () => {
  const message = 'DDEV rebuild failed. Try again; recovery may still be needed.';
  h.post.mockRejectedValueOnce(new Error(message));
  render(<Fixture />);
  fireEvent.click(screen.getByRole('button', { name: 'Rebuild DDEV' }));
  expect(await screen.findByText(message)).toBeTruthy();
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  expect(screen.queryByText(/still pending/i)).toBeNull();
});
