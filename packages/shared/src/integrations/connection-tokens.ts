import { decrypt, decryptDek, encrypt, encryptDek, generateDek } from '../crypto/index.js';

export interface ConnectionTokens {
  accessToken: string;
  refreshToken: string | null;
}

export interface ConnectionTokenColumns {
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string | null;
  encryptedDek: string | null;
}

/** Both tokens under one new DEK, which the KEK wraps: the three token columns of a connection. */
export function encryptConnectionTokens(
  tokens: ConnectionTokens,
  kek: string,
): { accessTokenEncrypted: string; refreshTokenEncrypted: string | null; encryptedDek: string } {
  const dek = generateDek();
  return {
    accessTokenEncrypted: encrypt(tokens.accessToken, dek),
    refreshTokenEncrypted: tokens.refreshToken === null ? null : encrypt(tokens.refreshToken, dek),
    encryptedDek: encryptDek(dek, kek),
  };
}

export function decryptConnectionTokens(
  columns: ConnectionTokenColumns,
  kek: string,
): ConnectionTokens {
  if (columns.accessTokenEncrypted === null || columns.encryptedDek === null) {
    throw new Error('integration connection holds no tokens');
  }
  const dek = decryptDek(columns.encryptedDek, kek);
  return {
    accessToken: decrypt(columns.accessTokenEncrypted, dek),
    refreshToken:
      columns.refreshTokenEncrypted === null ? null : decrypt(columns.refreshTokenEncrypted, dek),
  };
}
