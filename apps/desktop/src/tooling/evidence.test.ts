import { describe, expect, it } from 'vitest';

import { validateEvidenceBatch } from './evidence';

const source = {
  capabilityId: 'media.scene',
  kind: 'tool',
  version: '1.2.0',
};

describe('structured evidence validator', () => {
  it('accepts video time points and ranges within the material duration', () => {
    const result = validateEvidenceBatch(
      [
        {
          confidence: 0.92,
          evidenceId: 'ev-1',
          evidenceType: 'scene.hook',
          locator: { kind: 'video_time', startMs: 0 },
          mediaKind: 'video',
          schemaVersion: 1,
          source,
          text: '开场出现商品主体',
        },
        {
          confidence: 0.8,
          evidenceId: 'ev-2',
          evidenceType: 'speech.cta',
          locator: { endMs: 9_000, kind: 'video_time', startMs: 7_500 },
          mediaKind: 'video',
          schemaVersion: 1,
          source,
          text: '结尾行动号召',
        },
      ],
      { durationMs: 10_000, mediaKind: 'video' },
    );
    expect(result).toEqual({ issues: [], ok: true });
  });

  it('rejects duplicate IDs, out-of-duration ranges and unknown evidence fields', () => {
    const result = validateEvidenceBatch(
      [
        {
          confidence: 1.2,
          evidenceId: 'duplicate',
          evidenceType: 'scene.hook',
          locator: { endMs: 11_000, kind: 'video_time', startMs: 9_000 },
          mediaKind: 'video',
          schemaVersion: 1,
          source,
          text: 'x',
        },
        {
          apiKey: 'must-not-be-accepted',
          confidence: 0.5,
          evidenceId: 'duplicate',
          evidenceType: 'scene.hook',
          locator: { kind: 'video_time', startMs: 1 },
          mediaKind: 'video',
          schemaVersion: 1,
          source,
          text: 'x',
        },
      ],
      { durationMs: 10_000, mediaKind: 'video' },
    );
    expect(result.ok).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(['CONFIDENCE', 'DUPLICATE_ID', 'UNKNOWN_FIELD', 'VIDEO_DURATION']),
    );
  });

  it('accepts normalized image regions and rejects regions crossing the image edge', () => {
    const valid = validateEvidenceBatch(
      [
        {
          confidence: 0.7,
          evidenceId: 'image-1',
          evidenceType: 'product.subject',
          locator: { height: 0.8, kind: 'image_region', width: 0.5, x: 0.2, y: 0.1 },
          mediaKind: 'image',
          schemaVersion: 1,
          source,
          text: '服饰主体',
        },
      ],
      { mediaKind: 'image' },
    );
    expect(valid.ok).toBe(true);
    const invalid = validateEvidenceBatch(
      [
        {
          confidence: 0.7,
          evidenceId: 'image-2',
          evidenceType: 'product.subject',
          locator: { height: 0.3, kind: 'image_region', width: 0.4, x: 0.8, y: 0.8 },
          mediaKind: 'image',
          schemaVersion: 1,
          source,
          text: '越界区域',
        },
      ],
      { mediaKind: 'image' },
    );
    expect(invalid.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'IMAGE_REGION' })]),
    );
  });
});
