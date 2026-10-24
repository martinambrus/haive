import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const start = vi.hoisted(() => vi.fn());
vi.mock('./api-client', () => ({ startTask: start }));
import { startTaskWithAttachmentConfirmation } from './start-task';

const confirm = vi.fn();
beforeEach(() => {
  start.mockReset();
  confirm.mockReset();
  vi.stubGlobal('window', { confirm });
});
afterEach(() => vi.unstubAllGlobals());

describe('attachment start confirmations', () => {
  it.each([
    { status: 409, body: { landed: 0, expected: 3 } },
    { status: 500, code: 'task_attachments_missing', body: { landed: 0, expected: 3 } },
    { status: 409, code: 'task_attachments_missing', body: { landed: '0', expected: 3 } },
    { status: 409, code: 'task_attachments_missing', body: { landed: 3, expected: 3 } },
    { status: 409, code: 'task_attachments_missing', body: null },
  ])('does not turn an unrelated or malformed refusal into consent: %j', async (detail) => {
    const error = Object.assign(new Error('1 of 3 attachments are missing. Start anyway?'), detail);
    start.mockRejectedValue(error);
    await expect(startTaskWithAttachmentConfirmation('draft')).rejects.toBe(error);
    expect(confirm).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('reports a failed confirmed start without asking again', async () => {
    start.mockRejectedValueOnce(
      Object.assign(new Error('unrelated words'), {
        status: 409,
        code: 'task_attachments_missing',
        body: { landed: 0, expected: 3 },
      }),
    );
    const busy = new Error('busy');
    start.mockRejectedValueOnce(busy);
    confirm.mockReturnValue(true);
    await expect(startTaskWithAttachmentConfirmation('draft')).rejects.toBe(busy);
    expect(confirm).toHaveBeenCalledOnce();
    expect(start.mock.calls).toEqual([['draft'], ['draft', true]]);
  });
});
