import { safeStorage } from 'electron';

import { MaterialSessionError, MaterialSessionService } from '../media/session';
import type { LocalMaterialSummary, MaterialMismatch, MaterialSession } from '../media/types';
import type {
  AnalysisRecord,
  MaterialReferenceSnapshot,
  RecordSourceAccessResult,
} from './types';

export interface RecordSourceCipher {
  decryptPath(ciphertext: Buffer): Promise<string>;
  encryptPath(plainText: string): Promise<Buffer>;
}

export class ElectronRecordSourceCipher implements RecordSourceCipher {
  async encryptPath(plainText: string): Promise<Buffer> {
    await this.requireAvailable();
    try {
      return await safeStorage.encryptStringAsync(plainText);
    } catch {
      throw new RecordSourceAccessError(
        'SOURCE_UNAVAILABLE',
        '系统安全存储当前不可用，报告已保存但源素材需要重新定位',
      );
    }
  }

  async decryptPath(ciphertext: Buffer): Promise<string> {
    await this.requireAvailable();
    try {
      return (await safeStorage.decryptStringAsync(ciphertext)).result;
    } catch {
      throw new RecordSourceAccessError(
        'SOURCE_UNAVAILABLE',
        '无法读取源素材安全引用，请重新定位原文件',
      );
    }
  }

  private async requireAvailable(): Promise<void> {
    try {
      if (await safeStorage.isAsyncEncryptionAvailable()) return;
    } catch {
      // Mapped to the bounded error below.
    }
    throw new RecordSourceAccessError(
      'SOURCE_UNAVAILABLE',
      '系统安全存储当前不可用，无法恢复源素材引用',
    );
  }
}

export class RecordSourceAccessError extends Error {
  readonly code: 'INVALID_INPUT' | 'SOURCE_UNAVAILABLE';

  constructor(code: 'INVALID_INPUT' | 'SOURCE_UNAVAILABLE', message: string) {
    super(message);
    this.name = 'RecordSourceAccessError';
    this.code = code;
  }
}

interface RelocatedRecordSource {
  access: RecordSourceAccessResult;
  encryptedPath: string | null;
}

const expectedSummary = (
  material: MaterialReferenceSnapshot,
): Pick<LocalMaterialSummary, 'fingerprintSha256' | 'kind' | 'name' | 'size'> => {
  if (!material.fingerprintSha256) {
    throw new RecordSourceAccessError(
      'INVALID_INPUT',
      '该记录没有可校验的素材指纹，无法恢复源素材',
    );
  }
  return {
    fingerprintSha256: material.fingerprintSha256,
    kind: material.mediaKind,
    name: material.displayName,
    size: material.byteSize,
  };
};

const matches = (
  expected: ReturnType<typeof expectedSummary>,
  candidate: LocalMaterialSummary,
): boolean => expected.kind === candidate.kind
  && expected.size === candidate.size
  && expected.fingerprintSha256 === candidate.fingerprintSha256;

const mismatchFor = (
  expected: ReturnType<typeof expectedSummary>,
  candidate: LocalMaterialSummary,
): MaterialMismatch => ({
  candidate: {
    kind: candidate.kind,
    name: candidate.name,
    size: candidate.size,
  },
  expected: {
    kind: expected.kind,
    name: expected.name,
    size: expected.size,
  },
});

const unavailable = (): RecordSourceAccessResult => ({
  cancelled: false,
  mismatch: null,
  session: null,
  sourceStatus: 'needs_relocation',
});

export class RecordSourceAccessService {
  constructor(
    private readonly sessions: MaterialSessionService,
    private readonly cipher: RecordSourceCipher,
  ) {}

  async sealSession(
    sessionId: string,
    material: MaterialReferenceSnapshot,
  ): Promise<string> {
    const expected = expectedSummary(material);
    const source = await this.sessions.resolveToolSource(sessionId);
    if (!matches(expected, source.summary)) {
      throw new RecordSourceAccessError(
        'INVALID_INPUT',
        '当前素材会话与待确认报告的源素材不一致',
      );
    }
    return (await this.cipher.encryptPath(source.filePath)).toString('base64');
  }

  async openEncrypted(
    record: AnalysisRecord,
    encryptedPath: string,
  ): Promise<RecordSourceAccessResult> {
    let candidatePath: string;
    try {
      candidatePath = await this.cipher.decryptPath(Buffer.from(encryptedPath, 'base64'));
    } catch (error) {
      if (error instanceof RecordSourceAccessError) return unavailable();
      throw error;
    }
    return (await this.openCandidate(record, candidatePath, false)).access;
  }

  async relocate(
    record: AnalysisRecord,
    candidatePath: string,
  ): Promise<RelocatedRecordSource> {
    return this.openCandidate(record, candidatePath, true);
  }

  releaseSession(sessionId: string): void {
    this.sessions.release(sessionId);
  }

  private async openCandidate(
    record: AnalysisRecord,
    candidatePath: string,
    encryptMatch: boolean,
  ): Promise<RelocatedRecordSource> {
    const expected = expectedSummary(record.material);
    let session: MaterialSession;
    try {
      session = await this.sessions.register(candidatePath);
    } catch (error) {
      if (
        error instanceof MaterialSessionError
        && (error.code === 'NOT_FOUND' || error.code === 'PERMISSION_DENIED')
      ) {
        return { access: unavailable(), encryptedPath: null };
      }
      throw error;
    }
    if (!matches(expected, session.summary)) {
      this.sessions.release(session.sessionId);
      return {
        access: {
          cancelled: false,
          mismatch: mismatchFor(expected, session.summary),
          session: null,
          sourceStatus: 'mismatch',
        },
        encryptedPath: null,
      };
    }
    let encryptedPath: string | null = null;
    if (encryptMatch) {
      try {
        encryptedPath = (await this.cipher.encryptPath(
          (await this.sessions.resolveToolSource(session.sessionId)).filePath,
        )).toString('base64');
      } catch (error) {
        this.sessions.release(session.sessionId);
        throw error;
      }
    }
    return {
      access: {
        cancelled: false,
        mismatch: null,
        session,
        sourceStatus: 'available',
      },
      encryptedPath,
    };
  }
}
