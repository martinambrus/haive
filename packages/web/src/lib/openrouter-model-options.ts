import type { OpenRouterModelEntry } from './api-client';

/** Format a per-token price as the per-million-tokens figure people actually quote.
 *  A null price renders as '?' rather than 0 — a displayed 0 reads as "free", which
 *  is the one wrong answer that costs money. */
export function pricePerMillion(price: number | null): string {
  if (price === null) return '?';
  const perM = price * 1_000_000;
  if (perM === 0) return 'free';
  return `$${perM >= 1 ? perM.toFixed(2) : perM.toFixed(3)}`;
}

/** One `<option>` label: slug, context window, and both prices. */
export function optionLabel(m: OpenRouterModelEntry): string {
  const ctx = m.contextLength ? `${Math.round(m.contextLength / 1000)}k` : '?';
  const price = `${pricePerMillion(m.promptPrice)}/${pricePerMillion(m.completionPrice)} per M`;
  const noTools = m.supportsTools ? '' : '  [no tool support - unusable]';
  return `${m.id}  (${ctx} ctx, ${price})${noTools}`;
}

/** The options to render, given the catalog, the filter box and the saved value.
 *
 *  The load-bearing rule is the second one: the SAVED model is always present, even
 *  when the filter excludes it. Without that, typing in the filter box would drop
 *  the current value out of the select, the select would fall back to another
 *  option, and saving the form would silently rewrite a working provider's model. */
export function visibleModelOptions(
  models: readonly OpenRouterModelEntry[],
  filter: string,
  value: string,
): OpenRouterModelEntry[] {
  const q = filter.trim().toLowerCase();
  const matched = q
    ? models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
    : [...models];
  if (value && !matched.some((m) => m.id === value)) {
    const known = models.find((m) => m.id === value);
    if (known) return [known, ...matched];
  }
  return matched;
}

/** True when a saved value is not in the catalog at all (removed upstream, or typed
 *  before the picker existed). Such a value is still offered as its own option so it
 *  survives an edit untouched. */
export function isUnknownModel(models: readonly OpenRouterModelEntry[], value: string): boolean {
  return value !== '' && !models.some((m) => m.id === value);
}
