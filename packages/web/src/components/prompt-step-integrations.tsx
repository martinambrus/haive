'use client';

import {
  CORE_INTEGRATION_CATEGORY_SPECS,
  INTEGRATIONS_MAX_PER_STEP,
  type IntegrationRequirement,
} from '@haive/shared/modularity';
import { Button, Input } from '@/components/ui';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';

export type IntegrationCategoryOption = { id: string; label: string };

/** Keep raw stored entries until the author repairs or removes the entry. */
export function PromptStepIntegrations({
  integrations,
  categories = CORE_INTEGRATION_CATEGORY_SPECS,
  disabled = false,
  onChange,
}: {
  integrations: readonly unknown[] | undefined;
  categories?: readonly IntegrationCategoryOption[];
  disabled?: boolean;
  onChange: (requirements: IntegrationRequirement[]) => void;
}) {
  const items = integrations ?? [];
  const replace = (index: number, value: unknown) =>
    onChange(items.map((item, at) => (at === index ? value : item)) as IntegrationRequirement[]);
  return (
    <fieldset className="flex min-w-0 flex-col gap-3">
      <legend className="mb-1 text-sm text-neutral-300">Integrations</legend>
      <InlineMarkdown
        body="Declare the accounts this step needs. An optional integration lets the step run without an account. Write operations still require the account owner’s write switch."
        className="text-xs text-neutral-500"
      />
      {items.map((value, index) => {
        const item =
          value !== null && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {};
        const id = typeof item.id === 'string' ? item.id : '';
        const category = typeof item.category === 'string' ? item.category : '';
        const update = (patch: Record<string, unknown>) => replace(index, { ...item, ...patch });
        return (
          <div
            key={index}
            className="flex min-w-0 flex-col gap-2 rounded border border-neutral-800 p-3"
            role="group"
            aria-label={`Integration ${index + 1}`}
          >
            <label className="flex min-w-0 flex-col gap-1 text-xs text-neutral-400">
              Integration id
              <Input
                className="h-11 w-full min-w-0"
                value={id}
                maxLength={16}
                disabled={disabled}
                onChange={(event) => update({ id: event.target.value })}
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-xs text-neutral-400">
              Category
              <select
                className="h-11 w-full min-w-0 rounded border border-neutral-800 bg-neutral-950 px-2 text-sm"
                value={category}
                disabled={disabled}
                onChange={(event) => {
                  const { provider: _provider, ...rest } = item;
                  replace(index, { ...rest, category: event.target.value });
                }}
              >
                <option value="">Choose a category</option>
                {category && !categories.some((option) => option.id === category) && (
                  <option value={category}>{category} (unavailable)</option>
                )}
                {categories.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-neutral-400">
              Access
              <select
                className="h-11 w-full rounded border border-neutral-800 bg-neutral-950 px-2 text-sm"
                value={item.access === 'read' || item.access === 'write' ? item.access : ''}
                disabled={disabled}
                onChange={(event) => update({ access: event.target.value })}
              >
                <option value="">Choose access</option>
                <option value="read">Read</option>
                <option value="write">Read and write</option>
              </select>
            </label>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={item.optional === true}
                disabled={disabled}
                onChange={(event) => update({ optional: event.target.checked })}
              />
              Optional
            </label>
            {id && (
              <InlineMarkdown
                body={`Account token: \`{{integration:${id}.account}}\``}
                className="text-xs text-neutral-400 [overflow-wrap:anywhere]"
              />
            )}
            {item.provider !== undefined && (
              <InlineMarkdown
                body="Choose a category to replace this unsupported provider pin."
                className="text-xs text-amber-300"
              />
            )}
            <Button
              type="button"
              className="h-11 self-start"
              variant="destructive"
              disabled={disabled}
              onClick={() =>
                onChange(items.filter((_, at) => at !== index) as IntegrationRequirement[])
              }
            >
              Remove integration
            </Button>
          </div>
        );
      })}
      <Button
        type="button"
        className="h-11 self-start"
        variant="secondary"
        disabled={disabled || items.length >= INTEGRATIONS_MAX_PER_STEP}
        onClick={() => {
          const taken = new Set(
            items.flatMap((item) =>
              item && typeof item === 'object' && 'id' in item ? [item.id] : [],
            ),
          );
          let n = 1;
          while (taken.has(`account-${n}`)) n += 1;
          onChange([
            ...items,
            { id: `account-${n}`, category: categories[0]?.id ?? 'rich-documents', access: 'read' },
          ] as IntegrationRequirement[]);
        }}
      >
        Add integration
      </Button>
    </fieldset>
  );
}
