import { envelopeDecrypt, secretsService } from '@haive/shared';

/** Ciphertext length can identify empty strings, but only plaintext distinguishes blanks from
 * short real secrets (both have the same fingerprint). Keep values local to this filter. */
export async function configuredProviderSecrets<
  T extends { encryptedValue: string; encryptedDek: string },
>(rows: T[]): Promise<T[]> {
  if (rows.length === 0) return [];
  const masterKek = await secretsService.getMasterKek();
  return rows.filter((row) => envelopeDecrypt(row, masterKek).trim().length > 0);
}
