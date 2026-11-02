'use client';

import Link from 'next/link';
import type { TaskIntegrationChoice, TaskIntegrationPreview } from '@haive/shared';
import { Button } from '@/components/ui';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';

const REASONS: Record<string, string> = {
  'needs-choice': 'Choose an account.',
  'no-provider':
    'No provider serves this category on this install. Ask an administrator to install one.',
  'provider-disabled': 'The provider is disabled. Ask an administrator to enable it.',
  'provider-deactivated': 'The provider’s module is turned off. Ask an administrator to enable it.',
  'provider-missing': 'The provider’s module is no longer installed.',
  'no-connection': 'Connect an account in Settings.',
  'connection-unavailable':
    'The selected account needs attention. Reconnect it in Settings or choose another account.',
  'not-allowed-by-repository': 'The repository’s integration settings do not allow this account.',
  'no-repository': 'Select a repository for this integration.',
  'no-remote': 'This integration needs a repository with a Git remote.',
};

export function TaskIntegrationPicker({
  preview,
  pending,
  error,
  choices,
  onChange,
  onRetry,
}: {
  preview: TaskIntegrationPreview | null;
  pending: boolean;
  error: string | null;
  choices: readonly TaskIntegrationChoice[];
  onChange: (choices: TaskIntegrationChoice[]) => void;
  onRetry: () => void;
}) {
  if (!pending && !error && !preview?.categories.length && !preview?.issues.length) return null;
  return (
    <section
      className="flex min-w-0 flex-col gap-3 rounded-md border border-neutral-800 p-3"
      aria-label="Integrations"
    >
      <h2 className="text-sm font-medium">Integrations</h2>
      {pending && (
        <InlineMarkdown
          body="Checking integration accounts…"
          className="text-sm text-neutral-400"
        />
      )}
      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-2">
          <InlineMarkdown
            body={error}
            className="min-w-0 text-sm text-red-300 [overflow-wrap:anywhere]"
          />
          <Button type="button" variant="secondary" onClick={onRetry}>
            Retry integration check
          </Button>
        </div>
      )}
      {preview?.categories.map((category) => (
        <div key={category.categoryId} className="flex min-w-0 flex-col gap-1">
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            {category.label} account ({category.required ? 'Required' : 'Optional'})
            <select
              aria-label={`${category.label} account`}
              value={
                choices.find((pick) => pick.categoryId === category.categoryId)?.connectionId ?? ''
              }
              className="h-11 w-full min-w-0 max-w-full rounded-md border border-neutral-800 bg-neutral-950 px-2 text-sm"
              onChange={(event) =>
                onChange([
                  ...choices.filter((pick) => pick.categoryId !== category.categoryId),
                  ...(event.target.value
                    ? [{ categoryId: category.categoryId, connectionId: event.target.value }]
                    : []),
                ])
              }
            >
              <option value="">
                {category.selected
                  ? `Automatic: ${category.selected.accountLabel ?? category.selected.providerLabel} (${category.selected.providerLabel})`
                  : 'Choose an account'}
              </option>
              {category.candidates.map((account) => (
                <option
                  key={account.connectionId}
                  value={account.connectionId}
                  disabled={account.status !== 'connected'}
                >
                  {account.accountLabel ?? account.providerLabel} ({account.providerLabel})
                  {account.status !== 'connected' ? ' — reconnect required' : ''}
                </option>
              ))}
            </select>
          </label>
          <InlineMarkdown
            body={`Used by: ${[...new Set(category.steps.map((step) => step.title))].join(', ')}`}
            className="text-xs text-neutral-500 [overflow-wrap:anywhere]"
          />
          {category.status === 'unresolved' && (
            <InlineMarkdown
              body={
                REASONS[category.reason ?? ''] ??
                `Integration unavailable (${category.reason ?? 'unknown reason'}). Check Settings or contact an administrator.`
              }
              className="text-sm text-amber-300"
            />
          )}
        </div>
      ))}
      {!!preview?.issues.length && (
        <InlineMarkdown
          body="This task type has an unsupported integration requirement. Ask an administrator to repair the task type."
          className="text-sm text-amber-300"
        />
      )}
      <Link href="/settings/integrations" className="text-sm text-indigo-400 hover:underline">
        Manage integration accounts
      </Link>
    </section>
  );
}
