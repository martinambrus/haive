import { randomBytes } from 'node:crypto';
import { eq, asc } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { decrypt, encrypt } from '../crypto/index.js';
import { logger } from '../logger/index.js';
import { configService } from './config.service.js';

type DbClient = Database;

export const SECRET_KEYS = {
  JWT_SECRET: 'jwt_secret',
  EMAIL_BLIND_INDEX_PEPPER: 'email_blind_index_pepper',
  MASTER_KEK: 'master_kek',
  SMTP_PASSWORD: 'smtp_password',
  GITHUB_CLIENT_ID: 'github_client_id',
  GITHUB_CLIENT_SECRET: 'github_client_secret',
} as const;

export class SecretsService {
  private encryptionKey: string | null = null;
  private cache = new Map<string, string>();
  private initialized = false;
  private db: DbClient | null = null;

  async initialize(db: DbClient): Promise<void> {
    if (this.initialized) return;
    this.db = db;
    this.encryptionKey = await configService.getEncryptionKey();
    this.initialized = true;
    logger.info('SecretsService initialized');
  }

  async get(key: string): Promise<string | null> {
    this.ensureInitialized();
    if (this.cache.has(key)) {
      return this.cache.get(key)!;
    }
    const row = await this.db!.query.systemSecrets.findFirst({
      where: eq(schema.systemSecrets.key, key),
      columns: { encryptedValue: true },
    });
    if (!row) return null;
    try {
      const plaintext = decrypt(row.encryptedValue, this.encryptionKey!);
      this.cache.set(key, plaintext);
      return plaintext;
    } catch (err) {
      logger.error({ key, err }, 'Failed to decrypt secret');
      if (process.env.NODE_ENV === 'production') {
        throw new Error(`Failed to decrypt secret '${key}': encryption key may have changed`);
      }
      return null;
    }
  }

  async set(key: string, value: string, description?: string): Promise<void> {
    this.ensureInitialized();
    const encryptedValue = encrypt(value, this.encryptionKey!);
    await this.db!.insert(schema.systemSecrets)
      .values({
        key,
        encryptedValue,
        description: description ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.systemSecrets.key,
        set: {
          encryptedValue,
          ...(description !== undefined ? { description } : {}),
          updatedAt: new Date(),
        },
      });
    this.cache.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.ensureInitialized();
    await this.db!.delete(schema.systemSecrets).where(eq(schema.systemSecrets.key, key));
    this.cache.delete(key);
  }

  async listKeys(): Promise<{ key: string; description: string | null; updatedAt: Date }[]> {
    this.ensureInitialized();
    const rows = await this.db!.select({
      key: schema.systemSecrets.key,
      description: schema.systemSecrets.description,
      updatedAt: schema.systemSecrets.updatedAt,
    })
      .from(schema.systemSecrets)
      .orderBy(asc(schema.systemSecrets.key));
    return rows.map((row) => ({
      key: row.key,
      description: row.description,
      updatedAt: row.updatedAt ?? new Date(),
    }));
  }

  async getJwtSecret(): Promise<string> {
    const existing = await this.get(SECRET_KEYS.JWT_SECRET);
    if (existing) return existing;
    const generated = randomBytes(64).toString('hex');
    await this.set(SECRET_KEYS.JWT_SECRET, generated, 'JWT signing secret');
    logger.info('Generated new JWT secret');
    return generated;
  }

  async getEmailBlindIndexPepper(): Promise<string> {
    const existing = await this.get(SECRET_KEYS.EMAIL_BLIND_INDEX_PEPPER);
    if (existing) return existing;
    const generated = randomBytes(32).toString('hex');
    await this.set(
      SECRET_KEYS.EMAIL_BLIND_INDEX_PEPPER,
      generated,
      'Email blind index HMAC pepper',
    );
    logger.info('Generated new email blind index pepper');
    return generated;
  }

  async getMasterKek(): Promise<string> {
    const existing = await this.get(SECRET_KEYS.MASTER_KEK);
    if (existing) return existing;
    const generated = randomBytes(32).toString('hex');
    await this.set(SECRET_KEYS.MASTER_KEK, generated, 'Master KEK for envelope encryption');
    logger.info('Generated new master KEK');
    return generated;
  }

  clearCache(): void {
    this.cache.clear();
  }

  private ensureInitialized(): void {
    if (!this.initialized || !this.db) {
      throw new Error('SecretsService not initialized. Call initialize(db) first.');
    }
  }
}

export const secretsService = new SecretsService();
