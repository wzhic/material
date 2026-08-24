import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  LocalMaterialSummary,
  MaterialMismatch,
  MaterialSession,
  MATERIAL_PROTOCOL_SCHEME,
} from './types';

interface MaterialSessionEntry {
  absolutePath: string;
  modifiedAtMs: number;
  session: MaterialSession;
}

interface FileDescription {
  absolutePath: string;
  modifiedAtMs: number;
  summary: LocalMaterialSummary;
}

const VIDEO_TYPES: Record<string, string> = {
  avi: 'video/x-msvideo',
  m4v: 'video/x-m4v',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

const IMAGE_TYPES: Record<string, string> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  heic: 'image/heic',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

const extensionOf = (filePath: string): string =>
  path.extname(filePath).slice(1).toLocaleLowerCase('en-US');

const typeForPath = (
  filePath: string,
): Pick<LocalMaterialSummary, 'kind' | 'mimeType'> | null => {
  const extension = extensionOf(filePath);
  if (VIDEO_TYPES[extension]) {
    return { kind: 'video', mimeType: VIDEO_TYPES[extension] };
  }
  if (IMAGE_TYPES[extension]) {
    return { kind: 'image', mimeType: IMAGE_TYPES[extension] };
  }
  return null;
};

const fingerprintFile = (filePath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });

export class MaterialSessionError extends Error {
  readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'PERMISSION_DENIED' | 'UNKNOWN';

  constructor(
    code: 'INVALID_INPUT' | 'NOT_FOUND' | 'PERMISSION_DENIED' | 'UNKNOWN',
    message: string,
  ) {
    super(message);
    this.name = 'MaterialSessionError';
    this.code = code;
  }
}

const safeError = (error: unknown, fallback: string): MaterialSessionError => {
  if (error instanceof MaterialSessionError) {
    return error;
  }
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT') {
    return new MaterialSessionError('NOT_FOUND', '本地素材已移动或删除，请重新定位');
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new MaterialSessionError(
      'PERMISSION_DENIED',
      '无法读取本地素材，请重新授权或重新定位',
    );
  }
  return new MaterialSessionError('UNKNOWN', fallback);
};

export class MaterialSessionService {
  private readonly sessions = new Map<string, MaterialSessionEntry>();

  async register(filePath: string): Promise<MaterialSession> {
    const described = await this.describe(filePath);
    const sessionId = randomUUID();
    const session: MaterialSession = {
      previewUrl: `${MATERIAL_PROTOCOL_SCHEME}://session/${sessionId}`,
      sessionId,
      sourceStatus: 'available',
      summary: described.summary,
    };
    this.sessions.set(sessionId, {
      absolutePath: described.absolutePath,
      modifiedAtMs: described.modifiedAtMs,
      session,
    });
    return session;
  }

  async inspect(sessionId: string): Promise<MaterialSession> {
    const entry = this.requireSession(sessionId);
    try {
      const described = await this.describe(entry.absolutePath);
      const status = this.compare(entry.session.summary, described.summary)
        ? 'available'
        : 'mismatch';
      entry.session = { ...entry.session, sourceStatus: status };
      if (status === 'available') {
        entry.modifiedAtMs = described.modifiedAtMs;
      }
    } catch (error) {
      const safe = safeError(error, '无法校验本地素材，请重试');
      if (safe.code === 'NOT_FOUND' || safe.code === 'PERMISSION_DENIED') {
        entry.session = { ...entry.session, sourceStatus: 'needs_relocation' };
      } else {
        throw safe;
      }
    }
    return entry.session;
  }

  async relocate(
    sessionId: string,
    candidatePath: string,
  ): Promise<{ mismatch: MaterialMismatch | null; session: MaterialSession }> {
    const entry = this.requireSession(sessionId);
    const candidate = await this.describe(candidatePath);
    if (!this.compare(entry.session.summary, candidate.summary)) {
      entry.session = { ...entry.session, sourceStatus: 'mismatch' };
      return {
        mismatch: {
          candidate: {
            kind: candidate.summary.kind,
            name: candidate.summary.name,
            size: candidate.summary.size,
          },
          expected: {
            kind: entry.session.summary.kind,
            name: entry.session.summary.name,
            size: entry.session.summary.size,
          },
        },
        session: entry.session,
      };
    }
    entry.absolutePath = candidate.absolutePath;
    entry.modifiedAtMs = candidate.modifiedAtMs;
    entry.session = {
      ...entry.session,
      sourceStatus: 'available',
      summary: candidate.summary,
    };
    return { mismatch: null, session: entry.session };
  }

  release(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  clear(): void {
    this.sessions.clear();
  }

  async resolvePreviewSource(
    sessionId: string,
  ): Promise<{ filePath: string; mimeType: string; size: number } | null> {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.session.sourceStatus !== 'available') {
      return null;
    }
    try {
      const metadata = await stat(entry.absolutePath);
      if (
        !metadata.isFile() ||
        metadata.size !== entry.session.summary.size ||
        metadata.mtimeMs !== entry.modifiedAtMs
      ) {
        entry.session = { ...entry.session, sourceStatus: 'mismatch' };
        return null;
      }
      return {
        filePath: entry.absolutePath,
        mimeType: entry.session.summary.mimeType,
        size: entry.session.summary.size,
      };
    } catch {
      entry.session = { ...entry.session, sourceStatus: 'needs_relocation' };
      return null;
    }
  }

  private requireSession(sessionId: string): MaterialSessionEntry {
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
      throw new MaterialSessionError('INVALID_INPUT', '本地素材会话标识无效');
    }
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new MaterialSessionError('NOT_FOUND', '本地素材会话已结束，请重新选择');
    }
    return entry;
  }

  private async describe(filePath: string): Promise<FileDescription> {
    try {
      const absolutePath = await realpath(filePath);
      const mediaType = typeForPath(absolutePath);
      if (!mediaType) {
        throw new MaterialSessionError(
          'INVALID_INPUT',
          '当前文件不是支持的视频或图片，请重新选择',
        );
      }
      const metadataBefore = await stat(absolutePath);
      if (!metadataBefore.isFile()) {
        throw new MaterialSessionError('INVALID_INPUT', '请选择一个本地素材文件');
      }
      const fingerprintSha256 = await fingerprintFile(absolutePath);
      const metadataAfter = await stat(absolutePath);
      if (
        metadataBefore.size !== metadataAfter.size ||
        metadataBefore.mtimeMs !== metadataAfter.mtimeMs
      ) {
        throw new MaterialSessionError(
          'INVALID_INPUT',
          '素材在校验期间发生变化，请稳定文件后重试',
        );
      }
      return {
        absolutePath,
        modifiedAtMs: metadataAfter.mtimeMs,
        summary: {
          fingerprintAlgorithm: 'sha256-full-v1',
          fingerprintSha256,
          ...mediaType,
          name: path.basename(absolutePath),
          size: metadataAfter.size,
        },
      };
    } catch (error) {
      throw safeError(error, '无法读取本地素材，请重试');
    }
  }

  private compare(expected: LocalMaterialSummary, candidate: LocalMaterialSummary): boolean {
    return (
      expected.kind === candidate.kind &&
      expected.size === candidate.size &&
      expected.fingerprintSha256 === candidate.fingerprintSha256
    );
  }
}
