// @novnc/novnc ships no TypeScript types; minimal surface we use. Declared for the
// BARE package specifier: novnc 1.7.0's `exports: "./core/rfb.js"` blocks the
// `/core/rfb` subpath at bundle time, so BrowserVncPanel imports the bare package.
declare module '@novnc/novnc' {
  export default class RFB {
    constructor(target: HTMLElement, url: string, options?: Record<string, unknown>);
    scaleViewport: boolean;
    resizeSession: boolean;
    disconnect(): void;
    /** Send text to the remote's clipboard (client → server paste). */
    clipboardPasteFrom(text: string): void;
    addEventListener(type: string, listener: (e: Event) => void): void;
  }
}
