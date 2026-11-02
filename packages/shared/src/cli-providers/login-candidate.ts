import { envelopeDecrypt, envelopeEncrypt, type EnvelopeEncrypted } from '../crypto/index.js';

/** The queue carries ciphertext only; this credential is never an active provider secret. */
export function encryptCliLoginCandidate(
  userId: string,
  providerId: string,
  token: string,
  masterKek: string,
): EnvelopeEncrypted {
  return envelopeEncrypt(
    JSON.stringify({
      purpose: 'cli-login-candidate',
      userId,
      providerId,
      token,
    }),
    masterKek,
  );
}

export function decryptCliLoginCandidate(
  envelope: EnvelopeEncrypted,
  userId: string,
  providerId: string,
  masterKek: string,
): string {
  try {
    const candidate = JSON.parse(envelopeDecrypt(envelope, masterKek));
    if (
      candidate.purpose !== 'cli-login-candidate' ||
      candidate.userId !== userId ||
      candidate.providerId !== providerId ||
      typeof candidate.token !== 'string' ||
      !candidate.token
    )
      throw new Error();
    return candidate.token;
  } catch {
    // JSON errors can quote the decrypted text. Never attach the original as a cause.
    throw new Error('Invalid login candidate');
  }
}
