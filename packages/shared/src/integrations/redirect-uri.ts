export function oauthRedirectUri(webOrigin: string, providerId: string): string {
  return `${webOrigin}/settings/integrations/callback/${encodeURIComponent(providerId)}`;
}
