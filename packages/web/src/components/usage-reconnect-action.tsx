'use client';

import type { CliProviderName } from '@/lib/api-client';
import { useCliLogin } from '@/lib/use-cli-login';
import { usageReconnectFix, usageReconnectHint, usageReconnectHref } from '@/lib/usage-reconnect';

/** The dead-usage-token prompt, shared by the tasks-list strip and the task-detail header so
 *  the two cannot drift.
 *
 *  For a CLI whose repair is an interactive login it OPENS THAT LOGIN, rather than dropping
 *  the user on a settings page to hunt for the button — the same one-click contract claude's
 *  Reconnect already has, where a click lands you on the vendor's sign-in. `CliLoginProvider`
 *  wraps the whole (app) layout, so the modal is reachable from every page that renders this.
 *
 *  Still an anchor, not a bare button: the href is a real destination, so middle-click and
 *  open-in-new-tab keep working and the status bar shows where a click leads. The handler is
 *  the enhancement on top and pre-empts only a plain left click; a modified click falls
 *  through to the browser. Providers repaired by a token edit (zai, gemini) or by a separate
 *  OAuth (claude-code) have no in-page flow to start, so for them this stays the plain link it
 *  has always been. */
/** Counterpart to UsageReconnectAction for a credential that has ALREADY been repaired and is
 *  waiting on the next poll. Deliberately inert and grey: the user has done their part, and
 *  anything clickable here reads as "do it again". Lives beside the prompt so the two states
 *  are edited together and one can never quietly outlive the other. */
export function UsagePendingChip({
  displayName,
  className,
}: {
  displayName: string;
  className?: string;
}) {
  return (
    <span
      className={className}
      title={`${displayName} was just reconnected — waiting for its next usage reading (up to ~5 min). No action needed.`}
    >
      <span aria-hidden>⏳</span>
      <span>{displayName}</span>
      <span>waiting for usage data…</span>
    </span>
  );
}

export function UsageReconnectAction({
  providerId,
  providerName,
  providerLabel,
  displayName,
  className,
}: {
  providerId: string;
  providerName: CliProviderName | null;
  /** The row's own label (a clone name like "Codex xHigh") — what the login modal announces. */
  providerLabel: string | null;
  /** Short CLI name for the chip itself ("Codex"), so both surfaces read the same. */
  displayName: string;
  className?: string;
}) {
  const { requireCliLogin } = useCliLogin();
  const startsLogin = providerName !== null && usageReconnectFix(providerName) === 'cli-login';

  return (
    <a
      href={usageReconnectHref(providerId, providerName)}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        if (!startsLogin || !providerName) return;
        // Let ctrl/cmd/shift click open the settings page the way the href promises.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        requireCliLogin({
          providerId,
          providerLabel: providerLabel ?? displayName,
          providerName,
        });
      }}
      className={className}
      title={
        startsLogin
          ? `${displayName} usage token was rejected — sign in again to restore its meters.`
          : usageReconnectHint(providerLabel ?? displayName, providerName, { newTab: true })
      }
    >
      <span aria-hidden>⚠</span>
      <span>{displayName}</span>
      <span className="underline">reconnect</span>
    </a>
  );
}
