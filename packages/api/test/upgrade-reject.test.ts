import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { rejectUpgrade } from '../src/lib/upgrade-auth.js';

describe('shared upgrade refusal', () => {
  for (const status of [401, 403, 404, 409, 500, 503]) {
    it(`writes one HTTP ${status} response then destroys the transport`, () => {
      const socket = new PassThrough();
      const write = vi.spyOn(socket, 'write');
      const destroy = vi.spyOn(socket, 'destroy');
      rejectUpgrade(socket, status, 'Status');
      expect(write).toHaveBeenCalledExactlyOnceWith(
        `HTTP/1.1 ${status} Status\r\nConnection: close\r\n\r\n`,
      );
      expect(destroy).toHaveBeenCalledOnce();
    });
  }

  for (const state of ['ended', 'destroyed']) {
    it(`leaves an already ${state} transport alone`, () => {
      const socket = new PassThrough();
      if (state === 'ended') socket.end();
      else socket.destroy();
      const write = vi.spyOn(socket, 'write');
      const destroy = vi.spyOn(socket, 'destroy');
      rejectUpgrade(socket, 401, 'Status');
      expect(write).not.toHaveBeenCalled();
      expect(destroy).not.toHaveBeenCalled();
    });
  }

  it('destroys the transport even when writing throws', () => {
    const socket = new PassThrough();
    vi.spyOn(socket, 'write').mockImplementation(() => {
      throw new Error('write failed');
    });
    const destroy = vi.spyOn(socket, 'destroy');
    expect(() => rejectUpgrade(socket, 401, 'Status')).not.toThrow();
    expect(destroy).toHaveBeenCalledOnce();
  });
});
