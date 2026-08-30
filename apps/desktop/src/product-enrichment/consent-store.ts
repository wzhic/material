import { chmod, lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { GameEnrichmentProviderContract } from './types';

const MAX_CONSENT_FILE_BYTES = 4096;

interface PersistentConsent {
  grantedAt: string;
  providerId: string;
  providerVersion: string;
  sentFields: ['gameName'];
}

interface ConsentEnvelope {
  consent: PersistentConsent | null;
  schemaVersion: 1;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseConsent = (value: unknown): PersistentConsent | null => {
  if (!isRecord(value)) return null;
  if (typeof value.providerId !== 'string' || value.providerId.length > 128) return null;
  if (typeof value.providerVersion !== 'string' || value.providerVersion.length > 128) {
    return null;
  }
  if (typeof value.grantedAt !== 'string' || Number.isNaN(Date.parse(value.grantedAt))) {
    return null;
  }
  if (!Array.isArray(value.sentFields)
    || value.sentFields.length !== 1
    || value.sentFields[0] !== 'gameName') return null;
  return {
    grantedAt: value.grantedAt,
    providerId: value.providerId,
    providerVersion: value.providerVersion,
    sentFields: ['gameName'],
  };
};

const matchesContract = (
  consent: PersistentConsent | null,
  contract: GameEnrichmentProviderContract,
): boolean => consent !== null
  && consent.providerId === contract.id
  && consent.providerVersion === contract.version
  && consent.sentFields.length === contract.sentFields.length
  && consent.sentFields.every((field, index) => field === contract.sentFields[index]);

export class GameEnrichmentConsentStore {
  private consent: PersistentConsent | null = null;
  private loadPromise: Promise<void> | null = null;
  private writeCounter = 0;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async has(contract: GameEnrichmentProviderContract): Promise<boolean> {
    await this.load();
    return matchesContract(this.consent, contract);
  }

  async grant(contract: GameEnrichmentProviderContract): Promise<void> {
    await this.load();
    this.consent = {
      grantedAt: this.now().toISOString(),
      providerId: contract.id,
      providerVersion: contract.version,
      sentFields: ['gameName'],
    };
    await this.persist();
  }

  async clear(): Promise<void> {
    await this.load();
    this.consent = null;
    await this.persist();
  }

  private async load(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this.loadFromDisk();
    await this.loadPromise;
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const metadata = await lstat(this.filePath);
      if (metadata.isSymbolicLink()
        || !metadata.isFile()
        || metadata.size > MAX_CONSENT_FILE_BYTES) return;
      const handle = await open(this.filePath, 'r');
      let content: string;
      try {
        const buffer = Buffer.alloc(MAX_CONSENT_FILE_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_CONSENT_FILE_BYTES) return;
        content = buffer.subarray(0, bytesRead).toString('utf8');
      } finally {
        await handle.close();
      }
      const parsed: unknown = JSON.parse(content);
      if (!isRecord(parsed) || parsed.schemaVersion !== 1) return;
      this.consent = parsed.consent === null ? null : parseConsent(parsed.consent);
    } catch {
      // Missing or malformed non-secret preferences fail closed to no consent.
    }
  }

  private async persist(): Promise<void> {
    this.writeCounter += 1;
    const writeId = this.writeCounter;
    const envelope: ConsentEnvelope = { consent: this.consent, schemaVersion: 1 };
    const operation = this.writeQueue.catch(() => undefined).then(async () => {
      const directory = path.dirname(this.filePath);
      await mkdir(directory, { mode: 0o700, recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.${writeId}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(envelope)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        });
        await rename(temporaryPath, this.filePath);
        await chmod(this.filePath, 0o600);
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    });
    this.writeQueue = operation;
    await operation;
  }
}
