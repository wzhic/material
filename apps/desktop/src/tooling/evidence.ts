export type EvidenceMediaKind = 'image' | 'video';
export type EvidenceSourceKind = 'fusion' | 'model' | 'tool';

export interface VideoTimeLocator {
  endMs?: number;
  kind: 'video_time';
  startMs: number;
}

export interface ImageRegionLocator {
  height: number;
  kind: 'image_region';
  width: number;
  x: number;
  y: number;
}

export interface EvidenceSource {
  capabilityId: string;
  kind: EvidenceSourceKind;
  version: string;
}

export interface StructuredEvidence {
  confidence: number;
  evidenceId: string;
  evidenceType: string;
  locator: ImageRegionLocator | VideoTimeLocator;
  mediaKind: EvidenceMediaKind;
  schemaVersion: 1;
  source: EvidenceSource;
  text: string;
}

export interface EvidenceValidationContext {
  durationMs?: number;
  mediaKind: EvidenceMediaKind;
}

export interface EvidenceValidationIssue {
  code: string;
  evidenceId: string | null;
  message: string;
}

export interface EvidenceValidationResult {
  issues: readonly EvidenceValidationIssue[];
  ok: boolean;
}

const CAPABILITY_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const EVIDENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TYPE_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const EXACT_KEYS = new Set([
  'confidence',
  'evidenceId',
  'evidenceType',
  'locator',
  'mediaKind',
  'schemaVersion',
  'source',
  'text',
]);

const issue = (
  evidenceId: string | null,
  code: string,
  message: string,
): EvidenceValidationIssue => ({ code, evidenceId, message });

const finiteInRange = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const validateLocator = (
  evidence: Record<string, unknown>,
  context: EvidenceValidationContext,
  id: string | null,
  issues: EvidenceValidationIssue[],
): void => {
  const locator = evidence.locator;
  if (!isRecord(locator)) {
    issues.push(issue(id, 'LOCATOR', 'evidence locator is missing or invalid'));
    return;
  }
  if (context.mediaKind === 'video') {
    const allowed = new Set(['kind', 'startMs', 'endMs']);
    if (Object.keys(locator).some((key) => !allowed.has(key))) {
      issues.push(issue(id, 'LOCATOR_KEYS', 'video locator contains unknown fields'));
    }
    const startMs = locator.startMs;
    const endMs = locator.endMs;
    if (locator.kind !== 'video_time' || !finiteInRange(startMs, 0, Infinity)) {
      issues.push(issue(id, 'VIDEO_TIME', 'video evidence requires a non-negative start time'));
      return;
    }
    if (
      endMs !== undefined &&
      (!finiteInRange(endMs, 0, Infinity) ||
        (typeof endMs === 'number' && endMs <= startMs))
    ) {
      issues.push(issue(id, 'VIDEO_RANGE', 'video range end must be after start'));
    }
    if (
      context.durationMs !== undefined &&
      (startMs > context.durationMs ||
        (typeof endMs === 'number' && endMs > context.durationMs))
    ) {
      issues.push(issue(id, 'VIDEO_DURATION', 'video evidence is outside material duration'));
    }
    return;
  }
  const allowed = new Set(['kind', 'x', 'y', 'width', 'height']);
  if (Object.keys(locator).some((key) => !allowed.has(key))) {
    issues.push(issue(id, 'LOCATOR_KEYS', 'image locator contains unknown fields'));
  }
  const x = locator.x;
  const y = locator.y;
  const width = locator.width;
  const height = locator.height;
  if (
    locator.kind !== 'image_region' ||
    !finiteInRange(x, 0, 1) ||
    !finiteInRange(y, 0, 1) ||
    !finiteInRange(width, 0, 1) ||
    !finiteInRange(height, 0, 1) ||
    width === 0 ||
    height === 0 ||
    (typeof x === 'number' && typeof width === 'number' && x + width > 1) ||
    (typeof y === 'number' && typeof height === 'number' && y + height > 1)
  ) {
    issues.push(issue(id, 'IMAGE_REGION', 'image evidence region must fit normalized bounds'));
  }
};

export const validateEvidenceBatch = (
  values: readonly unknown[],
  context: EvidenceValidationContext,
): EvidenceValidationResult => {
  const issues: EvidenceValidationIssue[] = [];
  const ids = new Set<string>();
  if (
    context.mediaKind === 'video' &&
    (context.durationMs === undefined || !finiteInRange(context.durationMs, 0, Infinity))
  ) {
    issues.push(issue(null, 'DURATION', 'video duration is required and must be non-negative'));
  }
  for (const value of values) {
    if (!isRecord(value)) {
      issues.push(issue(null, 'TYPE', 'evidence must be an object'));
      continue;
    }
    const id = typeof value.evidenceId === 'string' ? value.evidenceId : null;
    if (Object.keys(value).some((key) => !EXACT_KEYS.has(key))) {
      issues.push(issue(id, 'UNKNOWN_FIELD', 'evidence contains an unknown field'));
    }
    if (!id || !EVIDENCE_ID_PATTERN.test(id)) {
      issues.push(issue(id, 'EVIDENCE_ID', 'evidenceId is invalid'));
    } else if (ids.has(id)) {
      issues.push(issue(id, 'DUPLICATE_ID', 'evidenceId must be unique within a batch'));
    } else {
      ids.add(id);
    }
    if (value.schemaVersion !== 1) {
      issues.push(issue(id, 'SCHEMA_VERSION', 'unsupported evidence schema version'));
    }
    if (value.mediaKind !== context.mediaKind) {
      issues.push(issue(id, 'MEDIA_KIND', 'evidence media kind does not match the material'));
    }
    if (
      typeof value.evidenceType !== 'string' ||
      !TYPE_PATTERN.test(value.evidenceType)
    ) {
      issues.push(issue(id, 'EVIDENCE_TYPE', 'evidence type is invalid'));
    }
    if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 10_000) {
      issues.push(issue(id, 'TEXT', 'evidence text must be non-empty and bounded'));
    }
    if (!finiteInRange(value.confidence, 0, 1)) {
      issues.push(issue(id, 'CONFIDENCE', 'confidence must be between 0 and 1'));
    }
    if (!isRecord(value.source)) {
      issues.push(issue(id, 'SOURCE', 'evidence source is invalid'));
    } else {
      const sourceKeys = new Set(['capabilityId', 'kind', 'version']);
      if (Object.keys(value.source).some((key) => !sourceKeys.has(key))) {
        issues.push(issue(id, 'SOURCE_KEYS', 'evidence source contains unknown fields'));
      }
      if (
        typeof value.source.capabilityId !== 'string' ||
        !CAPABILITY_PATTERN.test(value.source.capabilityId)
      ) {
        issues.push(issue(id, 'SOURCE_CAPABILITY', 'source capability is invalid'));
      }
      if (!['fusion', 'model', 'tool'].includes(String(value.source.kind))) {
        issues.push(issue(id, 'SOURCE_KIND', 'source kind is invalid'));
      }
      if (
        typeof value.source.version !== 'string' ||
        !VERSION_PATTERN.test(value.source.version)
      ) {
        issues.push(issue(id, 'SOURCE_VERSION', 'source version is invalid'));
      }
    }
    validateLocator(value, context, id, issues);
  }
  return { issues, ok: issues.length === 0 };
};
