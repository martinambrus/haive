/** The one place the redirect URI is spelled: the authorize request sends it and the admin page shows it for registering. */
export function oauthRedirectUri(webOrigin: string, providerId: string): string {
  return `${webOrigin}/settings/integrations/callback/${encodeURIComponent(providerId)}`;
}
