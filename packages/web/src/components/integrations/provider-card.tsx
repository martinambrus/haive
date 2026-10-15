'use client';

import Link from 'next/link';
import { Badge, Button, Card } from '@/components/ui';
import {
  categoryLabel,
  connectChoices,
  type ConnectMethod,
  type GitCredentialRow,
  type IntegrationProvider,
} from '@/lib/integrations';

const CONNECT_LABEL: Record<ConnectMethod, (name: string) => string> = {
  oauth2: (name) => `Sign in with ${name}`,
  device: (name) => `Sign in with ${name} using a device code`,
};

const HINT_CLASS = 'text-xs text-neutral-400';
const LINK_CLASS = 'text-indigo-300 underline hover:text-indigo-200';

function NoSignIn({ provider }: { provider: IntegrationProvider }) {
  if (provider.id === 'github') {
    return (
      <p className={HINT_CLASS}>
        Signing in with GitHub needs an OAuth client ID. Save yours in the GitHub OAuth card below,
        or ask an administrator to add one.
      </p>
    );
  }
  if (provider.categories.includes('forge')) {
    return (
      <p className={HINT_CLASS}>
        {provider.displayName} connects through a Git credential. Add one under{' '}
        <Link href="/settings/credentials" className={LINK_CLASS}>
          Git Credentials
        </Link>
        , then use it as a connection here.
      </p>
    );
  }
  return (
    <p className={HINT_CLASS}>
      No sign-in is set up for {provider.displayName} yet. An administrator can add an OAuth client
      under Admin, Integrations.
    </p>
  );
}

export function ProviderCard({
  provider,
  linkable,
  busy,
  onConnect,
  onWriteSwitch,
  onLink,
}: {
  provider: IntegrationProvider;
  linkable: GitCredentialRow[];
  busy: boolean;
  onConnect: (method: ConnectMethod) => void;
  onWriteSwitch: (next: boolean) => void;
  onLink: (credential: GitCredentialRow) => void;
}) {
  const choices = connectChoices(provider.connect);

  return (
    <Card className="flex flex-col gap-4 p-4" data-provider-id={provider.id}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h4 className="text-base font-semibold text-neutral-50">{provider.displayName}</h4>
          {provider.categories.map((category) => (
            <Badge key={category} variant="info">
              {categoryLabel(category)}
            </Badge>
          ))}
        </div>
        {provider.canWrite && (
          <label className="flex min-h-11 items-center gap-2 text-sm text-neutral-200">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={provider.writeEnabled}
              disabled={busy}
              onChange={(event) => onWriteSwitch(event.target.checked)}
            />
            Allow write access
          </label>
        )}
      </div>

      {choices.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {choices.map((method) => (
            <Button
              key={method}
              type="button"
              size="sm"
              className="max-sm:h-auto max-sm:min-h-11 max-sm:whitespace-normal max-sm:py-2"
              disabled={busy}
              onClick={() => onConnect(method)}
            >
              {CONNECT_LABEL[method](provider.displayName)}
            </Button>
          ))}
        </div>
      ) : (
        <NoSignIn provider={provider} />
      )}

      {linkable.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-neutral-200">Use a saved Git credential</p>
          <ul className="flex flex-col gap-2">
            {linkable.map((credential) => (
              <li
                key={credential.id}
                className="flex flex-col gap-2 rounded-md border border-neutral-800 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="text-sm text-neutral-100 [overflow-wrap:anywhere]">
                    {credential.label}
                  </div>
                  <div className="text-xs text-neutral-400 [overflow-wrap:anywhere]">
                    {credential.host}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="max-sm:h-11"
                  disabled={busy}
                  aria-label={`Use ${credential.label} as a ${provider.displayName} connection`}
                  onClick={() => onLink(credential)}
                >
                  Use as connection
                </Button>
              </li>
            ))}
          </ul>
          <p className="text-xs text-neutral-500">
            The connection points at the credential and copies nothing. Disconnecting it later
            leaves the credential as it is.
          </p>
        </div>
      )}
    </Card>
  );
}
