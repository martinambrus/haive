import { getDomain } from 'tldts';

/** An HTTP editor uses SameSite=Lax. A cross-site iframe cannot retain that session.
 * Compare schemeful sites, including private suffixes; ports do not define cookie sites.
 * IP literals and single-label hosts use their full hostname when no registrable domain exists. */
export function editorNeedsSecureCookie(webOrigin: string, editorUrl: string): boolean {
  const web = new URL(webOrigin);
  const editor = new URL(editorUrl);
  if (editor.protocol !== 'http:') return false;
  const site = (url: URL) =>
    `${url.protocol}//${getDomain(url.hostname, { allowPrivateDomains: true }) ?? url.hostname}`;
  return site(web) !== site(editor);
}
