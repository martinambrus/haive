import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { decryptCredentialRow } from '../repo/credentials.js';
import {
  ForgeError,
  apiBaseFits,
  credentialApiHost,
  credentialForgeProvider,
  credentialUsableForPr,
  hostFromRemote,
  parseRemote,
  resolveForgeProvider,
  type ForgeContext,
} from '@haive/shared/forge';

/** Build a ForgeContext for a repo's PR/MR call: resolve the credential's forge
 *  provider + optional API-base override, parse the remote URL, and decrypt the
 *  token. Throws a ForgeError (surfaced to the user) when the credential has no
 *  provider set — a hostname alone can't reveal the forge software — or does not fit the
 *  remote or its own API base, before the token is decrypted. */
export async function resolveForgeContext(args: {
  db: Database;
  userId: string;
  credentialId: string;
  remoteUrl: string;
}): Promise<ForgeContext> {
  const { db, userId, credentialId, remoteUrl } = args;

  // One read serves the checks and the decrypt, so an edit between them cannot split the two.
  const row = await db.query.repoCredentials.findFirst({
    where: and(
      eq(schema.repoCredentials.id, credentialId),
      eq(schema.repoCredentials.userId, userId),
    ),
    columns: {
      provider: true,
      host: true,
      apiBaseUrl: true,
      usernameEncrypted: true,
      secretEncrypted: true,
      encryptedDek: true,
    },
  });
  if (!row) throw new ForgeError('Credential not found for pull-request creation.');

  // Explicit credential provider wins; for a well-known public host fall back to inferring
  // from the remote host so the "auto-detect" default works without a manual pick.
  const provider = credentialForgeProvider(row.provider, hostFromRemote(remoteUrl));
  if (!provider) {
    throw new ForgeError(
      'This credential has no forge provider set, and the host is not a known public forge. Choose a provider (GitHub, Gitea/Forgejo, GitLab, Bitbucket) on the credential to open pull requests.',
    );
  }

  if (!credentialUsableForPr(row, remoteUrl)) {
    throw new ForgeError(
      "This credential is not for the repository's remote: its host and forge must match the remote's. Choose another credential, or edit this one's host and provider.",
    );
  }
  if (!apiBaseFits(row)) {
    throw new ForgeError(
      "Edit the credential's API base: it must be https on the credential's host or its forge's API host.",
    );
  }

  const creds = await decryptCredentialRow(row);
  const { host, owner, repo } = parseRemote(remoteUrl, provider);
  const impl = resolveForgeProvider(provider);
  const apiBase = (
    row.apiBaseUrl?.trim() || impl.defaultApiBase(credentialApiHost(row.host, remoteUrl))
  ).replace(/\/+$/, '');
  if (!apiBase) {
    throw new ForgeError(
      `Could not determine a REST API base URL for ${provider} on ${host}. Set an API base override on the credential.`,
    );
  }

  return { provider, apiBase, host, owner, repo, token: creds.secret, username: creds.username };
}
