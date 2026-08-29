import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    decryptStringAsync: vi.fn(),
    encryptStringAsync: vi.fn(),
    isAsyncEncryptionAvailable: vi.fn(),
  },
}));

import { MaterialSessionService } from '../media/session';
import type { AnalysisRecord, MaterialReferenceSnapshot } from './types';
import {
  RecordSourceAccessService,
  type RecordSourceCipher,
} from './source-access';

class XorCipher implements RecordSourceCipher {
  async encryptPath(plainText: string): Promise<Buffer> {
    return Buffer.from(
      [...Buffer.from(plainText, 'utf8')].map((value) => value ^ 0x5a),
    );
  }

  async decryptPath(ciphertext: Buffer): Promise<string> {
    return Buffer.from([...ciphertext].map((value) => value ^ 0x5a)).toString('utf8');
  }
}

const materialSnapshot = (
  fileName: string,
  fingerprintSha256: string,
  byteSize: number,
): MaterialReferenceSnapshot => ({
  byteSize,
  displayName: fileName,
  durationMs: 1_000,
  fingerprintSha256,
  height: 720,
  mediaKind: 'video',
  schemaVersion: 1,
  sourceStatus: 'needs_relocation',
  width: 1280,
});

describe('record source access service', () => {
  let directory: string;
  let originalPath: string;
  let movedPath: string;
  let differentPath: string;
  let sessions: MaterialSessionService;
  let service: RecordSourceAccessService;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'material-record-source-'));
    originalPath = path.join(directory, 'original.mp4');
    movedPath = path.join(directory, 'moved.mp4');
    differentPath = path.join(directory, 'different.mp4');
    writeFileSync(originalPath, 'same-source-bytes');
    writeFileSync(differentPath, 'different-source-bytes');
    sessions = new MaterialSessionService();
    service = new RecordSourceAccessService(sessions, new XorCipher());
  });

  afterEach(() => {
    sessions.clear();
    rmSync(directory, { force: true, recursive: true });
  });

  it('seals the main-process path and restores a verified preview session', async () => {
    const selected = await sessions.register(originalPath);
    const material = materialSnapshot(
      selected.summary.name,
      selected.summary.fingerprintSha256,
      selected.summary.size,
    );

    const encryptedPath = await service.sealSession(selected.sessionId, material);
    const restored = await service.openEncrypted(
      { id: 'record-1', material } as AnalysisRecord,
      encryptedPath,
    );

    expect(encryptedPath).not.toContain(originalPath);
    expect(restored).toMatchObject({
      mismatch: null,
      sourceStatus: 'available',
    });
    expect(restored.session?.previewUrl).toMatch(/^material-local:\/\/session\//);
  });

  it('reports relocation when the encrypted path no longer exists', async () => {
    const selected = await sessions.register(originalPath);
    const material = materialSnapshot(
      selected.summary.name,
      selected.summary.fingerprintSha256,
      selected.summary.size,
    );
    const encryptedPath = await service.sealSession(selected.sessionId, material);
    renameSync(originalPath, movedPath);

    const restored = await service.openEncrypted(
      { id: 'record-1', material } as AnalysisRecord,
      encryptedPath,
    );

    expect(restored).toEqual({
      cancelled: false,
      mismatch: null,
      session: null,
      sourceStatus: 'needs_relocation',
    });
  });

  it('accepts only a relocated file with the same complete fingerprint', async () => {
    const selected = await sessions.register(originalPath);
    const material = materialSnapshot(
      selected.summary.name,
      selected.summary.fingerprintSha256,
      selected.summary.size,
    );
    renameSync(originalPath, movedPath);

    const mismatch = await service.relocate(
      { id: 'record-1', material } as AnalysisRecord,
      differentPath,
    );
    const restored = await service.relocate(
      { id: 'record-1', material } as AnalysisRecord,
      movedPath,
    );

    expect(mismatch.access).toMatchObject({
      session: null,
      sourceStatus: 'mismatch',
    });
    expect(mismatch.encryptedPath).toBeNull();
    expect(restored.access).toMatchObject({
      mismatch: null,
      sourceStatus: 'available',
    });
    expect(restored.encryptedPath).toBeTruthy();
  });
});
