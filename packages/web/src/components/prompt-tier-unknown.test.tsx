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
