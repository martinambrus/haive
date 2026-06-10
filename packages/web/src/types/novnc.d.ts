// @novnc/novnc ships no TypeScript types; minimal surface we use.
declare module '@novnc/novnc/core/rfb' {
  export default class RFB {
    constructor(target: HTMLElement, url: string, options?: Record<string, unknown>);
    scaleViewport: boolean;
    resizeSession: boolean;
    disconnect(): void;
    addEventListener(type: string, listener: (e: Event) => void): void;
  }
}
