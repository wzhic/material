import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeStorage } from 'electron';

import { ModelServiceError } from './errors';
import {
  AvailableModel,
  ModelConnectionStatus,
  SaveModelConfigurationInput,
  SecureStorageStatus,
} from './types';

export interface SecretCipher {
  decrypt(ciphertext: Buffer): Promise<{ plainText: string; shouldReEncrypt: boolean }>;
  encrypt(plainText: string): Promise<Buffer>;
  status(): Promise<SecureStorageStatus>;
}

export class ElectronSafeStorageCipher implements SecretCipher {
  async status(): Promise<SecureStorageStatus> {
    try {
      const available = await safeStorage.isAsyncEncryptionAvailable();
      if (!available) {
        return {
          available: false,
          backend: 'unavailable',
          message: '系统安全存储当前不可用',
        };
      }
      if (process.platform === 'linux') {
        const backend = safeStorage.getSelectedStorageBackend();
        if (backend === 'basic_text' || backend === 'unknown') {
          return {
            available: false,
            backend: 'unavailable',
            message: '当前 Linux 环境没有可用的系统密钥服务',
          };
        }
        return { available: true, backend: 'secret-service', message: '系统密钥服务可用' };
      }
      if (process.platform === 'darwin') {
        return { available: true, backend: 'keychain', message: 'macOS 钥匙串可用' };
      }
      if (process.platform === 'win32') {
        return { available: true, backend: 'dpapi', message: 'Windows 凭据保护可用' };
      }
      return {
        available: false,
        backend: 'unavailable',
        message: '当前系统暂不支持安全存储模型凭据',
      };
    } catch {
      return {
        available: false,
        backend: 'unavailable',
        message: '系统安全存储当前不可用',
      };
    }
  }

  async encrypt(plainText: string): Promise<Buffer> {
    await this.requireAvailable();
    try {
      return await safeStorage.encryptStringAsync(plainText);
    } catch {
      throw new ModelServiceError('SECURE_STORAGE_UNAVAILABLE');
    }
  }

  async decrypt(ciphertext: Buffer): Promise<{
    plainText: string;
    shouldReEncrypt: boolean;
  }> {
    await this.requireAvailable();
    try {
      const result = await safeStorage.decryptStringAsync(ciphertext);
      return { plainText: result.result, shouldReEncrypt: result.shouldReEncrypt };
    } catch {
      throw new ModelServiceError('SECURE_STORAGE_UNAVAILABLE');
    }
  }

  private async requireAvailable(): Promise<void> {
    if (!(await this.status()).available) {
      throw new ModelServiceError('SECURE_STORAGE_UNAVAILABLE');
    }
  }
}

export interface StoredModelConfiguration {
  id: string;
  providerId: string;
  displayName: string;
  availableModels: AvailableModel[];
  selectedModelId: string | null;
  connectionStatus: ModelConnectionStatus;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
  writeVersion: number;
}

interface VaultConfiguration extends StoredModelConfiguration {
  encryptedApiKey: string;
}

interface VaultEnvelope {
  schemaVersion: 1;
  configurations: VaultConfiguration[];
}

const emptyEnvelope = (): VaultEnvelope => ({ configurations: [], schemaVersion: 1 });

const hasControlCharacters = (value: string): boolean =>
  [...value].some((character) => character.charCodeAt(0) < 32);

const validateDisplayName = (value: string): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > 80 || hasControlCharacters(normalized)) {
    throw new ModelServiceError('INVALID_INPUT');
  }
  return normalized;
};

const validateApiKey = (value: string): string => {
  if (
    value.length < 8
    || value.length > 512
    || value.trim() !== value
    || /\s/.test(value)
    || hasControlCharacters(value)
  ) {
    throw new ModelServiceError('INVALID_INPUT');
  }
  return value;
};

const validModels = (value: unknown): value is AvailableModel[] =>
  Array.isArray(value)
  && value.length <= 200
  && value.every((item) => {
    if (item === null || typeof item !== 'object') return false;
    const model = item as Record<string, unknown>;
    return typeof model.id === 'string'
      && model.id.length > 0
      && model.id.length <= 128
      && typeof model.ownedBy === 'string'
      && model.ownedBy.length <= 120;
  });

const validConfiguration = (value: unknown): value is VaultConfiguration => {
  if (value === null || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string'
    && /^[0-9a-f-]{36}$/.test(item.id)
    && typeof item.providerId === 'string'
    && /^[a-z][a-z0-9-]{0,31}$/.test(item.providerId)
    && typeof item.displayName === 'string'
    && item.displayName.length > 0
    && item.displayName.length <= 80
    && typeof item.encryptedApiKey === 'string'
    && item.encryptedApiKey.length > 0
    && item.encryptedApiKey.length <= 4096
    && validModels(item.availableModels)
    && (item.selectedModelId === null || typeof item.selectedModelId === 'string')
    && ['error', 'ready', 'unchecked'].includes(String(item.connectionStatus))
    && (item.lastCheckedAt === null || typeof item.lastCheckedAt === 'string')
    && typeof item.createdAt === 'string'
    && typeof item.updatedAt === 'string'
    && Number.isSafeInteger(item.writeVersion)
    && Number(item.writeVersion) >= 1;
};

const withoutCiphertext = (item: VaultConfiguration): StoredModelConfiguration => ({
  availableModels: item.availableModels.map((model) => ({ ...model })),
  connectionStatus: item.connectionStatus,
  createdAt: item.createdAt,
  displayName: item.displayName,
  id: item.id,
  lastCheckedAt: item.lastCheckedAt,
  providerId: item.providerId,
  selectedModelId: item.selectedModelId,
  updatedAt: item.updatedAt,
  writeVersion: item.writeVersion,
});

export class ModelCredentialVault {
  private operation = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly cipher: SecretCipher,
  ) {}

  secureStorageStatus(): Promise<SecureStorageStatus> {
    return this.cipher.status();
  }

  list(): Promise<StoredModelConfiguration[]> {
    return this.exclusive(async () => this.readEnvelope().configurations
      .map(withoutCiphertext)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
  }

  save(input: SaveModelConfigurationInput): Promise<StoredModelConfiguration> {
    return this.exclusive(async () => {
      const envelope = this.readEnvelope();
      const existingIndex = input.id
        ? envelope.configurations.findIndex((item) => item.id === input.id)
        : -1;
      const existing = existingIndex >= 0 ? envelope.configurations[existingIndex] : null;
      if (input.id && !existing) {
        throw new ModelServiceError('CONFIGURATION_NOT_FOUND');
      }
      if (
        existing
        && input.expectedWriteVersion !== existing.writeVersion
      ) {
        throw new ModelServiceError('CONFIGURATION_CHANGED');
      }
      if (!existing && input.expectedWriteVersion !== undefined) {
        throw new ModelServiceError('INVALID_INPUT');
      }
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(input.providerId)) {
        throw new ModelServiceError('INVALID_INPUT');
      }
      if (existing && existing.providerId !== input.providerId) {
        throw new ModelServiceError('INVALID_INPUT');
      }
      const apiKey = input.apiKey === undefined ? null : validateApiKey(input.apiKey);
      if (!existing && !apiKey) {
        throw new ModelServiceError('INVALID_INPUT');
      }
      const encryptedApiKey = apiKey
        ? (await this.cipher.encrypt(apiKey)).toString('base64')
        : existing?.encryptedApiKey;
      if (!encryptedApiKey) {
        throw new ModelServiceError('SECURE_STORAGE_UNAVAILABLE');
      }
      const now = new Date().toISOString();
      const keyChanged = Boolean(apiKey);
      const selectedModelId = input.selectedModelId === undefined
        ? existing?.selectedModelId ?? null
        : input.selectedModelId;
      if (
        !keyChanged
        && selectedModelId
        && !existing?.availableModels.some((model) => model.id === selectedModelId)
      ) {
        throw new ModelServiceError('MODEL_NOT_AVAILABLE');
      }
      const next: VaultConfiguration = {
        availableModels: keyChanged ? [] : existing?.availableModels ?? [],
        connectionStatus: keyChanged ? 'unchecked' : existing?.connectionStatus ?? 'unchecked',
        createdAt: existing?.createdAt ?? now,
        displayName: validateDisplayName(input.displayName),
        encryptedApiKey,
        id: existing?.id ?? randomUUID(),
        lastCheckedAt: keyChanged ? null : existing?.lastCheckedAt ?? null,
        providerId: input.providerId,
        selectedModelId: keyChanged ? null : selectedModelId ?? null,
        updatedAt: now,
        writeVersion: (existing?.writeVersion ?? 0) + 1,
      };
      if (existingIndex >= 0) {
        envelope.configurations[existingIndex] = next;
      } else {
        envelope.configurations.push(next);
      }
      this.writeEnvelope(envelope);
      return withoutCiphertext(next);
    });
  }

  remove(id: string, expectedWriteVersion: number): Promise<void> {
    return this.exclusive(async () => {
      const envelope = this.readEnvelope();
      const existing = envelope.configurations.find((item) => item.id === id);
      if (!existing) {
        throw new ModelServiceError('CONFIGURATION_NOT_FOUND');
      }
      if (existing.writeVersion !== expectedWriteVersion) {
        throw new ModelServiceError('CONFIGURATION_CHANGED');
      }
      envelope.configurations = envelope.configurations.filter((item) => item.id !== id);
      this.writeEnvelope(envelope);
    });
  }

  readCredential(id: string): Promise<{
    apiKey: string;
    configuration: StoredModelConfiguration;
  }> {
    return this.exclusive(async () => {
      const envelope = this.readEnvelope();
      const index = envelope.configurations.findIndex((item) => item.id === id);
      const item = envelope.configurations[index];
      if (!item) {
        throw new ModelServiceError('CONFIGURATION_NOT_FOUND');
      }
      const decrypted = await this.cipher.decrypt(Buffer.from(item.encryptedApiKey, 'base64'));
      const apiKey = validateApiKey(decrypted.plainText);
      if (decrypted.shouldReEncrypt) {
        item.encryptedApiKey = (await this.cipher.encrypt(apiKey)).toString('base64');
        item.updatedAt = new Date().toISOString();
        envelope.configurations[index] = item;
        this.writeEnvelope(envelope);
      }
      return { apiKey, configuration: withoutCiphertext(item) };
    });
  }

  updateConnection(
    id: string,
    status: 'error' | 'ready',
    models: AvailableModel[],
    expectedWriteVersion: number,
  ): Promise<StoredModelConfiguration> {
    return this.exclusive(async () => {
      const envelope = this.readEnvelope();
      const index = envelope.configurations.findIndex((item) => item.id === id);
      const item = envelope.configurations[index];
      if (!item) {
        throw new ModelServiceError('CONFIGURATION_NOT_FOUND');
      }
      if (item.writeVersion !== expectedWriteVersion) {
        throw new ModelServiceError('CONFIGURATION_CHANGED');
      }
      const now = new Date().toISOString();
      item.availableModels = models.map((model) => ({ ...model }));
      item.connectionStatus = status;
      item.lastCheckedAt = now;
      item.selectedModelId = item.selectedModelId
        && models.some((model) => model.id === item.selectedModelId)
        ? item.selectedModelId
        : models[0]?.id ?? null;
      item.updatedAt = now;
      item.writeVersion += 1;
      envelope.configurations[index] = item;
      this.writeEnvelope(envelope);
      return withoutCiphertext(item);
    });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  private readEnvelope(): VaultEnvelope {
    if (!existsSync(this.filePath)) {
      return emptyEnvelope();
    }
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown;
      if (
        raw === null
        || typeof raw !== 'object'
        || (raw as Record<string, unknown>).schemaVersion !== 1
        || !Array.isArray((raw as Record<string, unknown>).configurations)
        || !(raw as { configurations: unknown[] }).configurations.every(validConfiguration)
      ) {
        throw new Error('invalid vault envelope');
      }
      return raw as VaultEnvelope;
    } catch {
      throw new ModelServiceError('SECURE_STORAGE_UNAVAILABLE');
    }
  }

  private writeEnvelope(envelope: VaultEnvelope): void {
    const directory = path.dirname(this.filePath);
    mkdirSync(directory, { mode: 0o700, recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(envelope)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      renameSync(temporaryPath, this.filePath);
      chmodSync(this.filePath, 0o600);
    } catch {
      rmSync(temporaryPath, { force: true });
      throw new ModelServiceError('SECURE_STORAGE_UNAVAILABLE');
    }
  }
}
