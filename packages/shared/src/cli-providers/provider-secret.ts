import { schema, type Database } from '@haive/database';
import { computeKeyFingerprint, envelopeEncrypt } from '../crypto/index.js';

export interface UpsertProviderSecretInput {
  providerId: string;
  name: string;
  value: string;
  masterKek: string;
  onExisting: 'overwrite' | 'keep';
}

export interface ProviderSecretRow {
  id: string;
  secretName: string;
  fingerprint: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Stores one encrypted provider secret; `keep` leaves an existing secret of that name untouched. */
export async function upsertProviderSecret(
  db: Pick<Database, 'insert'>,
  input: UpsertProviderSecretInput,
): Promise<ProviderSecretRow> {
  const envelope = envelopeEncrypt(input.value, input.masterKek);
  const fingerprint = computeKeyFingerprint(input.value);
  const rows = await db
    .insert(schema.cliProviderSecrets)
    .values({
      providerId: input.providerId,
      secretName: input.name,
      encryptedValue: envelope.encryptedValue,
      encryptedDek: envelope.encryptedDek,
      fingerprint,
    })
    .onConflictDoUpdate({
      target: [schema.cliProviderSecrets.providerId, schema.cliProviderSecrets.secretName],
      set:
        input.onExisting === 'keep'
          ? { secretName: input.name }
          : {
              encryptedValue: envelope.encryptedValue,
              encryptedDek: envelope.encryptedDek,
              fingerprint,
              updatedAt: new Date(),
            },
    })
    .returning({
      id: schema.cliProviderSecrets.id,
      secretName: schema.cliProviderSecrets.secretName,
      fingerprint: schema.cliProviderSecrets.fingerprint,
      createdAt: schema.cliProviderSecrets.createdAt,
      updatedAt: schema.cliProviderSecrets.updatedAt,
    });
  return rows[0]!;
}
