import { describe, expect, it } from 'vitest';

import {
  detectMediaKind,
  formatFileSize,
  validateDraft,
} from './draft';

describe('detectMediaKind', () => {
  it('prefers the browser MIME type', () => {
    expect(detectMediaKind({ name: 'creative.bin', type: 'video/mp4' })).toBe(
      'video',
    );
    expect(detectMediaKind({ name: 'creative.bin', type: 'image/png' })).toBe(
      'image',
    );
  });

  it('falls back to a known extension when MIME is empty', () => {
    expect(detectMediaKind({ name: 'LOOKBOOK.MOV', type: '' })).toBe('video');
    expect(detectMediaKind({ name: 'LOOKBOOK.JPG', type: '' })).toBe('image');
    expect(detectMediaKind({ name: 'notes.txt', type: '' })).toBeNull();
  });
});

describe('validateDraft', () => {
  it('keeps real analysis disabled until a model is selected', () => {
    const result = validateDraft({
      industry: 'apparel',
      material: {
        kind: 'video',
        mimeType: 'video/mp4',
        name: 'dress.mp4',
        size: 1024,
      },
      modelId: '',
    });

    expect(result.canPreviewWorkspace).toBe(true);
    expect(result.canStartAnalysis).toBe(false);
    expect(result.errors).toContain('尚未配置并选择分析模型');
  });

  it('accepts the complete start contract', () => {
    const result = validateDraft({
      industry: 'game',
      material: {
        kind: 'image',
        mimeType: 'image/png',
        name: 'game.png',
        size: 2048,
      },
      modelId: 'configured-model',
    });

    expect(result.canStartAnalysis).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe('formatFileSize', () => {
  it('formats bounded local metadata without exposing a path', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1024 * 1024 * 12.5)).toBe('12.5 MB');
    expect(formatFileSize(-1)).toBe('未知大小');
  });
});
