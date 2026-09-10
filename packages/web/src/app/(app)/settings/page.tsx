import { redirect } from 'next/navigation';

/**
 * `/settings` has no landing content of its own — `settings/layout.tsx` is a tab bar and every
 * real page sits under it. Without this the bare path 404s, which is what a bookmark or a
 * hand-typed URL gets, even though the sidebar itself links straight to the account tab.
 *
 * Same destination the sidebar uses, so the two cannot disagree about where "Settings" is.
 */
export default function SettingsIndexPage() {
  redirect('/settings/account');
}
