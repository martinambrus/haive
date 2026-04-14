import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const KEY_LENGTH = 32;

function keyBufferFromHex(keyHex: string): Buffer {
  const buf = Buffer.from(keyHex, 'hex');
  if (buf.length !== KEY_LENGTH) {
    throw new Error(`Encryption key must be ${KEY_LENGTH} bytes (${KEY_LENGTH * 2} hex chars)`);
  }
  return buf;
}

export function encrypt(plaintext: string, keyHex: string): string {
  const key = keyBufferFromHex(keyHex);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

export function decrypt(encryptedData: string, keyHex: string): string {
  const parts = encryptedData.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted data format');
  }
  const [ivHex, authTagHex, ciphertext] = parts as [string, string, string];
  const key = keyBufferFromHex(keyHex);
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export function encryptEmail(email: string, keyHex: string): string {
  return encrypt(email.toLowerCase().trim(), keyHex);
}

export function decryptEmail(encryptedEmail: string, keyHex: string): string {
  return decrypt(encryptedEmail, keyHex);
}

export function computeEmailBlindIndex(email: string, pepper: string): string {
  const normalized = email.toLowerCase().trim();
  return createHmac('sha256', pepper).update(normalized).digest('hex');
}

export function generateDek(): string {
  return randomBytes(KEY_LENGTH).toString('hex');
}

export function generateEncryptionKey(): string {
  return randomBytes(KEY_LENGTH).toString('hex');
}

export function encryptDek(dekHex: string, kekHex: string): string {
  return encrypt(dekHex, kekHex);
}

export function decryptDek(encryptedDek: string, kekHex: string): string {
  return decrypt(encryptedDek, kekHex);
}

export interface EnvelopeEncrypted {
  encryptedValue: string;
  encryptedDek: string;
}

export function envelopeEncrypt(plaintext: string, kekHex: string): EnvelopeEncrypted {
  const dek = generateDek();
  const encryptedValue = encrypt(plaintext, dek);
  const encryptedDek = encryptDek(dek, kekHex);
  return { encryptedValue, encryptedDek };
}

export function envelopeDecrypt(envelope: EnvelopeEncrypted, kekHex: string): string {
  const dek = decryptDek(envelope.encryptedDek, kekHex);
  return decrypt(envelope.encryptedValue, dek);
}

export function computeKeyFingerprint(value: string): string {
  if (value.length <= 12) return '****';
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}
