import { eq, and } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  envelopeEncrypt,
  envelopeDecrypt,
  computeKeyFingerprint,
  type EnvelopeEncrypted,
} from '../crypto/index.js';
import { logger } from '../logger/index.js';

type DbClient = Database;

/**
 * Per-user envelope encryption.
 * Each secret has its own DEK; the DEK is wrapped with the master KEK.
 * Rotating the master KEK only requires re-wrapping DEKs, not re-encrypting values.
 */
export class UserSecretsService {
  private db: DbClient | null = null;
  private masterKek: string | null = null;
  private initialized = false;

  async initialize(db: DbClient, masterKek: string): Promise<void> {
    if (this.initialized) return;
    this.db = db;
    this.masterKek = masterKek;
    this.initialized = true;
    logger.info('UserSecretsService initialized');
  }

  async get(userId: string, keyName: string): Promise<string | null> {
    this.ensureInitialized();
    const row = await this.db!.query.userSecrets.findFirst({
      where: and(eq(schema.userSecrets.userId, userId), eq(schema.userSecrets.keyName, keyName)),
      columns: { encryptedValue: true, encryptedDek: true },
    });
    if (!row) return null;
    try {
      return envelopeDecrypt(
        { encryptedValue: row.encryptedValue, encryptedDek: row.encryptedDek },
        this.masterKek!,
      );
    } catch (err) {
      logger.error({ userId, keyName, err }, 'Failed to decrypt user secret');
      throw new Error('Failed to decrypt user secret');
    }
  }

  async set(userId: string, keyName: string, value: string, description?: string): Promise<void> {
    this.ensureInitialized();
    const envelope: EnvelopeEncrypted = envelopeEncrypt(value, this.masterKek!);
    const fingerprint = computeKeyFingerprint(value);
    await this.db!.insert(schema.userSecrets)
      .values({
        userId,
        keyName,
        encryptedValue: envelope.encryptedValue,
        encryptedDek: envelope.encryptedDek,
        fingerprint,
        description: description ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [schema.userSecrets.userId, schema.userSecrets.keyName],
        set: {
          encryptedValue: envelope.encryptedValue,
          encryptedDek: envelope.encryptedDek,
          fingerprint,
          ...(description !== undefined ? { description } : {}),
          updatedAt: new Date(),
        },
      });
  }

  async delete(userId: string, keyName: string): Promise<void> {
    this.ensureInitialized();
    await this.db!.delete(schema.userSecrets).where(
      and(eq(schema.userSecrets.userId, userId), eq(schema.userSecrets.keyName, keyName)),
    );
  }

  async listForUser(userId: string): Promise<{ keyName: string; fingerprint: string | null }[]> {
    this.ensureInitialized();
    const rows = await this.db!.query.userSecrets.findMany({
      where: eq(schema.userSecrets.userId, userId),
      columns: { keyName: true, fingerprint: true },
    });
    return rows.map((r: any) => ({ keyName: r.keyName, fingerprint: r.fingerprint }));
  }

  private ensureInitialized(): void {
    if (!this.initialized || !this.db || !this.masterKek) {
      throw new Error('UserSecretsService not initialized. Call initialize(db, kek) first.');
    }
  }
}

export const userSecretsService = new UserSecretsService();
