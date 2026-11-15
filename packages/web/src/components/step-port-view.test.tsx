import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('./step-port-canvas', () => {
  throw new Error('Canvas evaluated during SSR');
});
import { StepPortView } from './step-port-view';
describe('port view SSR boundary', () => {
  it('keeps the accessible list as stable default markup without evaluating the canvas', () => {
    expect(typeof window).toBe('undefined');
    const html = renderToStaticMarkup(
      <StepPortView request={{ path: '/tasks/t/ports' }}>
        <ol>
          <li>Original list</li>
        </ol>
      </StepPortView>,
    );
    expect(html).toContain('Original list');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Canvas');
    expect(html).not.toContain('react-flow');
  });
});
