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

export const UNKNOWN_TIER_DISPLAY_LIMIT = 50;

/** Each range belongs to one invocation; the cap keeps provider cards bounded. */
export function PromptTierUnknownList({
  tiers,
  display,
  total,
  limit = UNKNOWN_TIER_DISPLAY_LIMIT,
}: {
  tiers: { id?: string; modelKey?: string | null; lowUsd?: number; highUsd?: number }[];
  display?: CostDisplay | null;
  total?: number;
  limit?: number;
}) {
  const omitted = Math.max(0, (total ?? tiers.length) - Math.min(tiers.length, limit));
  return (
    <>
      {tiers.slice(0, limit).map((tier, index) => (
        <span key={tier.id ?? index}>
          <span title={tier.id}>
            Invocation {tier.id ? tier.id.slice(0, 8) : index + 1}
            {tier.modelKey ? ` (${tier.modelKey})` : ''}:{' '}
          </span>
          <PromptTierUnknown tier={tier} display={display} />
        </span>
      ))}
      {omitted > 0 && <span>{omitted} more invocations with prompt tier unknown</span>}
    </>
  );
}
