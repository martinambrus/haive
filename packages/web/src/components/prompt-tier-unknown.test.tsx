import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PromptTierUnknown } from './prompt-tier-unknown';

it('shows one invocation range in the task currency without converting missing bounds to zero', () => {
  const display = { currency: 'EUR', usdPerUnit: 2, rateDate: '2026-11-01', approximate: false };
  const text = renderToStaticMarkup(
    <PromptTierUnknown tier={{ lowUsd: 2, highUsd: 4 }} display={display} />,
  );
  expect(text).toContain('prompt tier unknown · €1.00–€2.00');
  for (const tier of [{}, { lowUsd: 0 }, { lowUsd: NaN, highUsd: Infinity }]) {
    expect(renderToStaticMarkup(<PromptTierUnknown tier={tier} />)).toContain(
      'prompt tier unknown · unpriced',
    );
  }
});

it('labels and caps the task inventory, disclosing omitted invocations', async () => {
  const { PromptTierUnknownList, UNKNOWN_TIER_DISPLAY_LIMIT } =
    await import('./prompt-tier-unknown');
  expect(UNKNOWN_TIER_DISPLAY_LIMIT).toBe(50);
  const text = renderToStaticMarkup(
    <PromptTierUnknownList
      tiers={[
        { id: 'abcdefgh-first', modelKey: 'first-model', lowUsd: 1, highUsd: 3 },
        { id: 'ijklmnop-second' },
        { id: 'hidden-third' },
      ]}
      limit={2}
    />,
  );
  expect(text).toContain('Invocation abcdefgh');
  expect(text).toContain('(first-model)');
  expect(text).toContain('Invocation ijklmnop');
  expect(text).not.toContain('hidden-third');
  expect(text).toContain('1 more invocations with prompt tier unknown');
  expect(text.match(/Excluded from cost totals/g)).toHaveLength(2);
});

it('discloses the server total when the SQL inventory is capped', async () => {
  const { PromptTierUnknownList } = await import('./prompt-tier-unknown');
  const text = renderToStaticMarkup(<PromptTierUnknownList tiers={[{ id: 'shown' }]} total={3} />);
  expect(text).toContain('2 more invocations with prompt tier unknown');
});
