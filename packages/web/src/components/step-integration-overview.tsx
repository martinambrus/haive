'use client';

import { integrationRequirementSchema } from '@haive/shared/modularity';
import {
  categoryInstallNote,
  integrationLabel,
  providerInstallState,
  type ComposerIntegrationInfo,
} from '@/lib/composer-integrations';
import type { IntegrationCategoryOption } from './prompt-step-integrations';
import { InlineMarkdown } from './markdown/inline-markdown';

export function StepIntegrationOverview({
  requirements,
  info,
  categories,
}: {
  requirements: readonly unknown[] | undefined;
  info: ComposerIntegrationInfo;
  categories: readonly IntegrationCategoryOption[];
}) {
  if (!requirements?.length) return null;
  return (
    <section
      aria-label="Integration requirements"
      className="mt-3 min-w-0 rounded border border-neutral-800 p-2 text-xs [overflow-wrap:anywhere]"
    >
      <h4 className="font-medium text-neutral-300">Integration requirements</h4>
      <div className="mt-2 flex min-w-0 flex-col gap-3">
        {requirements.map((raw, index) => {
          const item =
            raw && typeof raw === 'object' && !Array.isArray(raw)
              ? (raw as Record<string, unknown>)
              : {};
          const id = typeof item.id === 'string' ? item.id : `Requirement ${index + 1}`;
          const category = typeof item.category === 'string' ? item.category : null;
          const pin = typeof item.provider === 'string' ? item.provider : null;
          const parsed = integrationRequirementSchema.safeParse(raw);
          const options = category
            ? info.providers.filter((provider) => provider.categories.includes(category))
            : pin
              ? info.providers.filter((provider) => provider.id === pin)
              : [];
          const label = category
            ? categories.find((option) => option.id === category)?.label
            : undefined;
          const note =
            category && info.status === 'current' ? categoryInstallNote(category, info) : null;
          return (
            <div key={index} className="min-w-0 flex flex-col gap-1">
              <div className="flex flex-wrap gap-x-2 gap-y-1 text-neutral-300">
                <span className="font-mono">
                  {integrationLabel(id, `Requirement ${index + 1}`)}
                </span>
                <span>{item.optional === true ? 'Optional' : 'Required'}</span>
                <span>
                  {item.access === 'write'
                    ? 'Read and write'
                    : item.access === 'read'
                      ? 'Read'
                      : 'Access invalid'}
                </span>
              </div>
              {category && (
                <div className="text-neutral-400">
                  <span>{integrationLabel(label, category)}</span>
                  {label && label !== category && (
                    <span className="ml-2 font-mono">{category}</span>
                  )}
                </div>
              )}
              {!parsed.success && (
                <InlineMarkdown
                  body="Invalid stored requirement. Repair or remove it before using this step."
                  className="text-amber-300"
                />
              )}
              {pin && (
                <InlineMarkdown
                  body="Provider pin unsupported. Execution is deferred until provider pins are supported; choose a category to repair an authored requirement."
                  className="text-amber-300"
                />
              )}
              {note && <span className="text-amber-300">{note}</span>}
              {info.status !== 'current' ? (
                <InlineMarkdown
                  className="text-amber-300"
                  body={
                    info.status === 'loading'
                      ? 'Loading provider information. Install state is unverified.'
                      : 'Provider information unavailable. Refresh providers to verify install state.'
                  }
                />
              ) : (
                <>
                  {options.map((provider) => (
                    <div
                      key={provider.id}
                      className="flex min-w-0 flex-wrap gap-x-2 text-neutral-400"
                    >
                      <span>{integrationLabel(provider.displayName, provider.id)}</span>
                      <span className="font-mono">{provider.id}</span>
                      <span>{providerInstallState(provider.id, info)}</span>
                    </div>
                  ))}
                  {pin && options.length === 0 && (
                    <div className="text-amber-300">
                      <span className="font-mono">{pin}</span> — {providerInstallState(pin, info)}
                    </div>
                  )}
                  {category && options.length === 0 && (
                    <InlineMarkdown
                      className="text-amber-300"
                      body="No registered provider serves this category."
                    />
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
