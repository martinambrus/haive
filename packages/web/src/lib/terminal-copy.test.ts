import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOsc52Clipboard, type Osc52Clipboard } from './terminal-copy';

type Selection = Parameters<Osc52Clipboard['provider']['writeText']>[0];
const SYSTEM = 'c' as unknown as Selection;
const PRIMARY = 'p' as unknown as Selection;

function stubClipboard(writeText: (text: string) => Promise<void>) {
  vi.stubGlobal('navigator', { clipboard: { writeText, readText: async () => '' } });
}

afterEach(() => vi.unstubAllGlobals());

// flush() is not covered here: it goes through document.execCommand, and @haive/web runs
// vitest in the default node environment with no DOM.
describe('createOsc52Clipboard', () => {
  it('parks nothing when the browser accepts the write', async () => {
    stubClipboard(async () => {});
    const c = createOsc52Clipboard();
    await c.provider.writeText(SYSTEM, 'hello');
    expect(c.getPending()).toBeNull();
  });

  it('parks the text and notifies once when the browser refuses', async () => {
    stubClipboard(async () => {
      throw new DOMException('Clipboard write is not allowed', 'NotAllowedError');
    });
    const c = createOsc52Clipboard();
    const seen = vi.fn();
    c.subscribe(seen);
    await c.provider.writeText(SYSTEM, 'hello');
    expect(c.getPending()).toBe('hello');
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('does not re-notify when the same text is refused again', async () => {
    stubClipboard(async () => {
      throw new Error('nope');
    });
    const c = createOsc52Clipboard();
    const seen = vi.fn();
    c.subscribe(seen);
    await c.provider.writeText(SYSTEM, 'hello');
    await c.provider.writeText(SYSTEM, 'hello');
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('clears a parked value once a later write succeeds', async () => {
    let allow = false;
    stubClipboard(async () => {
      if (!allow) throw new Error('nope');
    });
    const c = createOsc52Clipboard();
    await c.provider.writeText(SYSTEM, 'hello');
    expect(c.getPending()).toBe('hello');
    allow = true;
    await c.provider.writeText(SYSTEM, 'world');
    expect(c.getPending()).toBeNull();
  });

  it('ignores a non-system selection', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('nope');
    });
    stubClipboard(writeText);
    const c = createOsc52Clipboard();
    await c.provider.writeText(PRIMARY, 'hello');
    expect(writeText).not.toHaveBeenCalled();
    expect(c.getPending()).toBeNull();
    expect(await c.provider.readText(PRIMARY)).toBe('');
  });

  // A task page mounts many terminals at once; one refused copy must raise a button on
  // exactly the terminal that asked for it.
  it('keeps two terminals independent', async () => {
    stubClipboard(async () => {
      throw new Error('nope');
    });
    const a = createOsc52Clipboard();
    const b = createOsc52Clipboard();
    await a.provider.writeText(SYSTEM, 'from a');
    expect(a.getPending()).toBe('from a');
    expect(b.getPending()).toBeNull();
  });

  it('unsubscribes', async () => {
    stubClipboard(async () => {
      throw new Error('nope');
    });
    const c = createOsc52Clipboard();
    const seen = vi.fn();
    c.subscribe(seen)();
    await c.provider.writeText(SYSTEM, 'hello');
    expect(seen).not.toHaveBeenCalled();
  });
});
