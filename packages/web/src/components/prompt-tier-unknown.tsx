import { formatCost, type CostDisplay } from '@/lib/format-cost';

export function PromptTierUnknown({
  tier,
  display,
}: {
  tier: { lowUsd?: number; highUsd?: number };
  display?: CostDisplay | null;
}) {
  const bounded =
    typeof tier.lowUsd === 'number' &&
    Number.isFinite(tier.lowUsd) &&
    typeof tier.highUsd === 'number' &&
    Number.isFinite(tier.highUsd);
  return (
    <span
      className="text-amber-300"
      title="Excluded from cost totals. Each range describes one invocation."
    >
      prompt tier unknown ·{' '}
      {bounded
        ? `${formatCost(tier.lowUsd!, display)}–${formatCost(tier.highUsd!, display)}`
        : 'unpriced'}
    </span>
  );
}
