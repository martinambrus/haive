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
    /** Inject a key event into the remote. keysym is X11 (e.g. 0xffe3 = Control_L,
     *  0x76 = 'v'); code is the DOM physical key (e.g. 'ControlLeft', 'KeyV'). */
    sendKey(keysym: number, code: string, down?: boolean): void;
    addEventListener(type: string, listener: (e: Event) => void): void;
  }
}
