import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Badge } from '@/components/ui';
import type { SlotWait } from '@/lib/api-client';
import { SlotWaitBadge } from './slot-wait-badge';

const KINDS = ['runtime', 'agent', 'module'] as const;

const render = (over: Partial<SlotWait> = {}) =>
  renderToStaticMarkup(
    <SlotWaitBadge
      slotWait={{
        kind: 'runtime',
        since: null,
        stepId: '01c-ddev-env',
        message: null,
        stale: false,
        ...over,
      }}
    />,
  );

const ENTITIES: Record<string, string> = {
  '&quot;': '"',
  '&amp;': '&',
  '&#x27;': "'",
  '&lt;': '<',
  '&gt;': '>',
};

const textOf = (html: string) => /<span class="truncate">([^<]*)<\/span>/.exec(html)?.[1];
const titleOf = (html: string) =>
  /title="([^"]*)"/.exec(html)?.[1]?.replace(/&(?:quot|amp|#x27|lt|gt);/g, (e) => ENTITIES[e]!);
const classOf = (html: string) => /class="([^"]*)"/.exec(html)?.[1];
const variantClass = (variant: 'warning' | 'error') =>
  classOf(renderToStaticMarkup(<Badge variant={variant} />));

describe('SlotWaitBadge', () => {
  it.each([
    ['runtime', 'waiting: runtime slot'],
    ['agent', 'waiting: agent slot'],
    ['module', 'waiting: module setup'],
  ] as const)('labels a %s wait', (kind, label) => {
    expect(textOf(render({ kind }))).toBe(label);
  });

  it.each([
    ['runtime', 'Queued for a free runtime slot'],
    ['agent', 'Queued for a free agent slot'],
    ['module', "Waiting for its module's setup to finish"],
  ] as const)(
    'titles a %s wait with its own sentence when the worker sent no message',
    (kind, title) => {
      expect(titleOf(render({ kind }))).toBe(title);
    },
  );

  it.each(KINDS)('titles a %s wait with the worker message when there is one', (kind) => {
    const message = 'Waiting for a free runtime slot (limit 2; 1 ahead in the queue)';
    expect(titleOf(render({ kind, message }))).toBe(message);
  });

  it('shows a live module wait in the warning variant, not as stalled', () => {
    const html = render({ kind: 'module', message: 'Setting up' });
    expect(classOf(html)).toBe(variantClass('warning'));
    expect(textOf(html)).not.toContain('stalled?');
  });

  it('shows a stale module wait as stalled, in the error variant, with the stale hint after the message', () => {
    expect(variantClass('error')).not.toBe(variantClass('warning'));
    const html = render({ kind: 'module', stale: true, message: 'Setting up' });
    expect(textOf(html)).toBe('waiting: module setup · stalled?');
    expect(classOf(html)).toBe(variantClass('error'));
    const title = titleOf(html)!;
    expect(title.startsWith('Setting up\n\n')).toBe(true);
    expect(title.length).toBeGreaterThan('Setting up\n\n'.length);
    expect(title).toBe(titleOf(render({ kind: 'runtime', stale: true, message: 'Setting up' })));
  });

  it.each(['runtime', 'agent'] as const)(
    'keeps the generic stale title for a %s wait that has no message',
    (kind) => {
      expect(titleOf(render({ kind, stale: true }))?.startsWith('Queued for a slot\n\n')).toBe(
        true,
      );
    },
  );
});
