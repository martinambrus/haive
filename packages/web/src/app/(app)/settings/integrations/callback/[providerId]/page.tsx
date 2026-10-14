'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api-client';
import { finishCallback, type CallbackOutcome } from '@/lib/integration-callback';
import { usePageTitle } from '@/lib/use-page-title';
import { Card, CardDescription, CardHeader, CardTitle, FormError } from '@/components/ui';

export default function IntegrationCallbackPage() {
  usePageTitle('Finishing the connection');
  const { providerId } = useParams<{ providerId: string }>();
  const [outcome, setOutcome] = useState<CallbackOutcome>({ kind: 'working' });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void finishCallback({
      search: window.location.search,
      providerId,
      pathname: window.location.pathname,
      replaceUrl: (pathname) => window.history.replaceState(null, '', pathname),
      complete: (body) =>
        api.post<{ connection: { accountLabel: string } }>('/integrations/oauth/complete', body),
    }).then(setOutcome);
  }, [providerId]);

  return (
    <Card className="flex flex-col gap-4" data-callback-outcome={outcome.kind}>
      <CardHeader className="mb-0">
        <CardTitle className="text-base">
          {outcome.kind === 'connected' ? 'Connected' : 'Finishing the connection'}
        </CardTitle>
        {outcome.kind === 'working' && (
          <CardDescription>Completing the sign-in with the provider...</CardDescription>
        )}
        {outcome.kind === 'connected' && (
          <CardDescription role="status" className="[overflow-wrap:anywhere]">
            {outcome.accountLabel} is connected ({providerId}).
          </CardDescription>
        )}
        {outcome.kind === 'nothing' && (
          <CardDescription>
            This page finishes a sign-in the provider sends you back from, and nothing came with
            this visit. Start the connection from the Integrations page.
          </CardDescription>
        )}
      </CardHeader>
      {outcome.kind === 'refused' && (
        <>
          <FormError message={outcome.message} />
          <p className="text-sm text-neutral-400">
            Nothing was connected. Go back to Integrations to start again.
          </p>
        </>
      )}
      {outcome.kind !== 'working' && (
        <Link
          href="/settings/integrations"
          className="inline-flex h-11 items-center justify-center self-start rounded-md border border-neutral-700 bg-neutral-800 px-4 text-sm font-medium text-neutral-100 hover:bg-neutral-700"
        >
          Back to Integrations
        </Link>
      )}
    </Card>
  );
}
