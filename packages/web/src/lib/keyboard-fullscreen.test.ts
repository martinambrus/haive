import { describe, expect, it, vi } from 'vitest';
import { createKeyboardFullscreen } from './keyboard-fullscreen';

function setup(withKeyboard = false) {
  const keyboard = { lock: vi.fn(async () => {}), unlock: vi.fn() };
  const doc = Object.assign(new EventTarget(), {
    fullscreenElement: null as HTMLElement | null,
    defaultView: { navigator: withKeyboard ? { keyboard } : {} },
    exitFullscreen: vi.fn(async () => {
      doc.fullscreenElement = null;
      doc.dispatchEvent(new Event('fullscreenchange'));
    }),
  });
  const element = {
    ownerDocument: doc,
    requestFullscreen: vi.fn(async (_options?: FullscreenOptions) => {
      doc.fullscreenElement = element as unknown as HTMLElement;
      doc.dispatchEvent(new Event('fullscreenchange'));
    }),
  };
  const focus = vi.fn();
  const update = vi.fn();
  const session = createKeyboardFullscreen(element as unknown as HTMLElement, focus, update);
  return { doc, element, keyboard, focus, update, session };
}

describe('VNC fullscreen keyboard capture', () => {
  it('requests Firefox’s native browser lock and focuses the viewer without navigator.keyboard', async () => {
    const { session, element, focus, update } = setup();
    await session.enter();
    expect(element.requestFullscreen).toHaveBeenCalledWith({ keyboardLock: 'browser' });
    expect(focus).toHaveBeenCalledOnce();
    expect(update).toHaveBeenLastCalledWith(true, null);
    session.dispose();
  });

  it('locks all keys in Chromium and releases them on browser fullscreen exit', async () => {
    const { session, keyboard, doc } = setup(true);
    await session.enter();
    expect(keyboard.lock).toHaveBeenCalledWith();
    await doc.exitFullscreen();
    expect(keyboard.unlock).toHaveBeenCalledOnce();
    session.dispose();
    expect(keyboard.unlock).toHaveBeenCalledOnce();
  });

  it('releases capture on explicit exit and can re-enter with fresh focus', async () => {
    const { session, keyboard, doc, focus } = setup(true);
    await session.enter();
    await session.exit();
    expect(keyboard.unlock).toHaveBeenCalledOnce();
    expect(doc.fullscreenElement).toBeNull();
    await session.enter();
    expect(focus).toHaveBeenCalledTimes(2);
    expect(keyboard.lock).toHaveBeenCalledTimes(2);
    session.dispose();
    expect(keyboard.unlock).toHaveBeenCalledTimes(2);
  });

  it('leaves an unrelated fullscreen viewer and its lock alone', async () => {
    const { session, keyboard, doc, element } = setup(true);
    doc.fullscreenElement = {} as HTMLElement;
    doc.dispatchEvent(new Event('fullscreenchange'));
    session.dispose();
    expect(keyboard.lock).not.toHaveBeenCalled();
    expect(keyboard.unlock).not.toHaveBeenCalled();
    expect(doc.exitFullscreen).not.toHaveBeenCalled();
    expect(element.requestFullscreen).not.toHaveBeenCalled();
  });

  it('keeps fullscreen and canvas focus when Chromium denies capture, and explains it', async () => {
    const { session, keyboard, doc, focus, update } = setup(true);
    keyboard.lock.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
    await session.enter();
    expect(focus).toHaveBeenCalledOnce();
    expect(doc.fullscreenElement).not.toBeNull();
    expect(update).toHaveBeenLastCalledWith(true, expect.stringContaining('denied'));
    session.dispose();
  });

  it('does not report a late permission failure after exit', async () => {
    const { session, keyboard, update } = setup(true);
    let reject!: (error: Error) => void;
    keyboard.lock.mockReturnValueOnce(
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
    );
    await session.enter();
    await session.exit();
    reject(new Error('Late denial'));
    await Promise.resolve();
    expect(update).toHaveBeenLastCalledWith(false, null);
    session.dispose();
  });

  it('does not grab keys or focus when fullscreen is refused', async () => {
    const { session, keyboard, element, focus, update } = setup(true);
    element.requestFullscreen.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
    await session.enter();
    expect(keyboard.lock).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(update).toHaveBeenLastCalledWith(false, expect.stringContaining('Could not enter'));
    session.dispose();
  });

  it('exits a fullscreen request that finishes after unmount, without grabbing keys', async () => {
    const { session, element, doc, keyboard, focus } = setup(true);
    let complete!: () => void;
    element.requestFullscreen.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = () => {
            doc.fullscreenElement = element as unknown as HTMLElement;
            doc.dispatchEvent(new Event('fullscreenchange'));
            resolve();
          };
        }),
    );
    const pending = session.enter();
    session.dispose();
    complete();
    await pending;
    expect(doc.fullscreenElement).toBeNull();
    expect(keyboard.lock).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it('cancels a pending fullscreen request when the viewer is hidden', async () => {
    const { session, element, doc, keyboard, focus } = setup(true);
    let complete!: () => void;
    element.requestFullscreen.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = () => {
            doc.fullscreenElement = element as unknown as HTMLElement;
            doc.dispatchEvent(new Event('fullscreenchange'));
            resolve();
          };
        }),
    );
    const pending = session.enter();
    await session.exit();
    complete();
    await pending;
    expect(doc.fullscreenElement).toBeNull();
    expect(keyboard.lock).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    session.dispose();
  });
});
