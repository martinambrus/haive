'use client';

import { useState } from 'react';
import type { CliProviderName } from '@/lib/api-client';
import { useCliLogin } from '@/lib/use-cli-login';
import { UsageOauthModal } from '@/components/usage-oauth-modal';
import { usageReconnectFix, usageReconnectHint, usageReconnectHref } from '@/lib/usage-reconnect';
import {
  usageFaultHref,
  usageFaultText,
  usageFaultTooltip,
  type UsageChipFault,
} from '@/lib/usage-chip-state';

/** The dead-usage-token prompt, shared by the tasks-list strip and the task-detail header so
 *  the two cannot drift.
 *
 *  A click STARTS THE REPAIR — an interactive CLI login, or the vendor's OAuth page for a
 *  usage-OAuth provider — rather than dropping the user on a settings page to hunt for the
 *  button that does it. Landing on an edit form was the whole complaint both times it was
 *  reported (grok's missing login, then claude-code's usage OAuth), so the rule now holds for
 *  every provider that HAS an in-product flow. `CliLoginProvider` wraps the whole (app)
 *  layout, so the login modal is reachable from every page that renders this; the OAuth dialog
 *  is local because this component is its only caller.
 *
 *  Still an anchor, not a bare button: the href is a real destination, so middle-click and
 *  open-in-new-tab keep working and the status bar shows where a click leads. The handler is
 *  the enhancement on top and pre-empts only a plain left click; a modified click falls
 *  through to the browser. Providers repaired by a token edit (zai, gemini) have no flow to
 *  start — nothing to open but the field to paste into — so for them this stays a plain link,
 *  aimed at that field. */
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

/** The chip for a meter that has no number to show AND a reason worth stating.
 *
 *  Three situations reach here, all of which used to render nothing at all: a metered CLI that
 *  never produced a reading, a fetch that failed, and a vendor that answered with no window.
 *  The fourth blank — a CLI with no usage endpoint at all — deliberately never reaches this;
 *  see lib/usage-chip-state. Which fault applies is decided there, not here.
 *
 *  Only the actionable one is a link, matching the amber-acts / grey-informs split this file
 *  already uses for UsageReconnectAction and UsagePendingChip. It opens in a new tab for the
 *  same reason the reconnect prompt does: losing the task page mid-run to go fix a credential
 *  is its own small disaster. */
export function UsageFaultChip({
  fault,
  displayName,
  className,
}: {
  fault: UsageChipFault;
  displayName: string;
  className?: string;
}) {
  const href = usageFaultHref(fault);
  const title = usageFaultTooltip(fault, displayName);
  const body = (
    <>
      <span aria-hidden>{href ? '⚠' : '—'}</span>
      <span>{displayName}</span>
      <span className={href ? 'underline' : undefined}>{usageFaultText(fault)}</span>
    </>
  );
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className} title={title}>
      {body}
    </a>
  ) : (
    <span className={className} title={title}>
      {body}
    </span>
  );
}

export function UsageReconnectAction({
  providerId,
  providerName,
  providerLabel,
  displayName,
  className,
  onRepaired,
}: {
  providerId: string;
  providerName: CliProviderName | null;
  /** The row's own label (a clone name like "Codex xHigh") — what the login modal announces. */
  providerLabel: string | null;
  /** Short CLI name for the chip itself ("Codex"), so both surfaces read the same. */
  displayName: string;
  className?: string;
  /** Refetch `/usage-window` — the repair finished in THIS tab, so nothing else will.
   *
   *  Both in-place flows end without a navigation or a focus change, which is what the
   *  surfaces' other refresh triggers key on, so the prompt sat there for up to a poll
   *  interval telling the user to redo what they had just done. The api already answers
   *  `pending` the moment the repair lands (it compares the credential's write time against
   *  the reading it contradicts), so a plain refetch is the whole fix — do NOT flip the chip
   *  locally instead: that re-derives server state at the call site, and a repair that did
   *  not take would then show a spinner that never resolves. */
  onRepaired?: () => void;
}) {
  const { requireCliLogin } = useCliLogin();
  const [oauthOpen, setOauthOpen] = useState(false);
  const fix = providerName === null ? 'api-token' : usageReconnectFix(providerName);
  const startsLogin = fix === 'cli-login';
  const startsOauth = fix === 'usage-oauth';

  return (
    <>
      <a
        href={usageReconnectHref(providerId, providerName)}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => {
          if (!providerName || (!startsLogin && !startsOauth)) return;
          // Let ctrl/cmd/shift click open the settings page the way the href promises.
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          if (startsOauth) {
            setOauthOpen(true);
            return;
          }
          requireCliLogin({
            providerId,
            providerLabel: providerLabel ?? displayName,
            providerName,
            // Fires on the modal's 'saved' frame, after the server-side probe has written
            // auth_status/auth_last_checked_at — the pair the api reads as this CLI's repair
            // instant. Unconditional: only a PASSING probe counts as a repair there, so an
            // abandoned login just refetches the same prompt.
            onComplete: () => onRepaired?.(),
          });
        }}
        className={className}
        title={
          startsLogin
            ? `${displayName} usage token was rejected — sign in again to restore its meters.`
            : startsOauth
              ? `${displayName} usage token expired — re-authorize it to restore its meters.`
              : usageReconnectHint(providerLabel ?? displayName, providerName, { newTab: true })
        }
      >
        <span aria-hidden>⚠</span>
        <span>{displayName}</span>
        <span className="underline">reconnect</span>
      </a>
      {startsOauth && (
        <UsageOauthModal
          open={oauthOpen}
          providerId={providerId}
          providerLabel={providerLabel ?? displayName}
          onClose={() => setOauthOpen(false)}
          onReconnected={() => onRepaired?.()}
        />
      )}
    </>
  );
}
