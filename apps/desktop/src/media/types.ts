import type { MediaKind } from '../analysis/draft';

export type MaterialSessionStatus = 'available' | 'mismatch' | 'needs_relocation';

export interface LocalMaterialSummary {
  fingerprintAlgorithm: 'sha256-full-v1';
  fingerprintSha256: string;
  kind: MediaKind;
  mimeType: string;
  name: string;
  size: number;
}

export interface MaterialSession {
  previewUrl: string;
  sessionId: string;
  sourceStatus: MaterialSessionStatus;
  summary: LocalMaterialSummary;
}

export interface MaterialMismatch {
  candidate: Pick<LocalMaterialSummary, 'kind' | 'name' | 'size'>;
  expected: Pick<LocalMaterialSummary, 'kind' | 'name' | 'size'>;
}

export type MaterialSelection =
  | { cancelled: true }
  | { cancelled: false; session: MaterialSession };

export type MaterialRelocation =
  | { cancelled: true }
  | {
      cancelled: false;
      mismatch: MaterialMismatch | null;
      session: MaterialSession;
    };

export type MaterialApiErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'UNKNOWN';

export type MaterialApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: MaterialApiErrorCode; message: string } };

export interface MaterialApi {
  inspect: (sessionId: string) => Promise<MaterialApiResult<MaterialSession>>;
  release: (sessionId: string) => Promise<MaterialApiResult<null>>;
  relocate: (sessionId: string) => Promise<MaterialApiResult<MaterialRelocation>>;
  select: () => Promise<MaterialApiResult<MaterialSelection>>;
}

export const MATERIAL_IPC_CHANNELS = {
  inspect: 'material:local-media:inspect',
  release: 'material:local-media:release',
  relocate: 'material:local-media:relocate',
  select: 'material:local-media:select',
} as const;

export const MATERIAL_PROTOCOL_SCHEME = 'material-local';
