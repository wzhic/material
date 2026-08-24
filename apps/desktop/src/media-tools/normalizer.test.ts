import { describe, expect, it } from 'vitest';

import { normalizeMediaEvidence } from './normalizer';

const material = {
  fingerprintAlgorithm: 'sha256-full-v1' as const,
  fingerprintSha256: 'a'.repeat(64),
  kind: 'video' as const,
  size: 100,
};

const probe = {
  bitRate: 100,
  durationMs: 5000,
  formatNames: ['mp4'],
  hasAudio: true,
  hasVideo: true,
  material,
  mediaKind: 'video' as const,
  probeVersion: 'ffprobe version test',
  schemaVersion: 1 as const,
  startTimeMs: 0,
  streams: [],
};

describe('media evidence normalizer', () => {
  it('creates a sorted, validated timeline without upgrading confidence', () => {
    const output = normalizeMediaEvidence({
      asr: {
        detectedLanguage: 'zh',
        material,
        runtimeVersion: 'test',
        schemaVersion: 1,
        segments: [{
          confidence: 0.6,
          endMs: 4500,
          segmentId: 'asr-1',
          speaker: null,
          startMs: 3500,
          text: '立即下单',
          words: [],
        }],
      },
      audio: {
        artifactRelativePath: 'audio.wav',
        channels: 1,
        hasAudio: true,
        integratedLoudnessLufs: -16,
        maxVolumeDb: -1,
        meanVolumeDb: -20,
        material,
        runtimeVersion: 'test',
        sampleRate: 16000,
        schemaVersion: 1,
        silence: [{ endMs: 1000, startMs: 500 }],
        waveform: [],
      },
      audioEvents: {
        events: [{
          confidence: 0.72,
          endMs: 3000,
          eventId: 'event-1',
          eventType: 'music',
          label: 'Music',
          startMs: 2000,
        }],
        limitations: [],
        material,
        modelVersion: 'yamnet',
        runtimeVersion: 'test',
        schemaVersion: 1,
      },
      mediaKind: 'video',
      ocr: {
        language: 'ch',
        material,
        runtimeVersion: 'test',
        schemaVersion: 1,
        segments: [{
          confidence: 0.8,
          endMs: 100,
          region: { height: 0.2, width: 0.8, x: 0.1, y: 0.7 },
          segmentId: 'ocr-1',
          startMs: 100,
          text: '限时新品',
        }],
      },
      probe,
      shots: {
        algorithm: 'ffmpeg-scene-v1',
        material,
        runtimeVersion: 'test',
        schemaVersion: 1,
        shots: [{ confidence: 0.55, endMs: 2000, keyframeMs: 1000, shotId: 's1', startMs: 0 }],
        threshold: 0.32,
      },
    });
    expect(output.evidence).toHaveLength(5);
    expect(output.timeline.map((entry) => entry.startMs)).toEqual([0, 100, 500, 2000, 3500]);
    expect(output.evidence.find((entry) => entry.evidenceType === 'visual.shot.candidate')?.confidence).toBe(0.55);
    expect(output.limitations).toEqual([]);
    expect(output.material).toEqual(material);
    expect(output.provenance.map((entry) => entry.capabilityId)).toContain(
      'media.evidence.normalize',
    );
  });

  it('uses image regions and records missing OCR as an explicit limitation', () => {
    const imageMaterial = { ...material, kind: 'image' as const };
    const imageProbe = {
      ...probe,
      durationMs: 0,
      hasAudio: false,
      material: imageMaterial,
      mediaKind: 'image' as const,
    };
    const missing = normalizeMediaEvidence({ mediaKind: 'image', probe: imageProbe });
    expect(missing).toMatchObject({ evidence: [], limitations: ['未提供 OCR 结果'], timeline: [] });
    const present = normalizeMediaEvidence({
      mediaKind: 'image',
      ocr: {
        language: 'ch',
        material: imageMaterial,
        runtimeVersion: 'test',
        schemaVersion: 1,
        segments: [{
          confidence: 0.9,
          endMs: null,
          region: { height: 0.2, width: 0.5, x: 0.1, y: 0.1 },
          segmentId: 'ocr-image',
          startMs: null,
          text: '商品图文字',
        }],
      },
      probe: imageProbe,
    });
    expect(present.evidence[0].locator).toMatchObject({ kind: 'image_region', x: 0.1 });
  });

  it('rejects evidence from another material or outside the probed duration', () => {
    expect(() => normalizeMediaEvidence({
      mediaKind: 'video',
      ocr: {
        language: 'ch',
        material: { ...material, fingerprintSha256: 'b'.repeat(64) },
        runtimeVersion: 'test',
        schemaVersion: 1,
        segments: [],
      },
      probe,
    })).toThrow('media.ocr 的结果不属于当前素材');
    expect(() => normalizeMediaEvidence({
      asr: {
        detectedLanguage: 'zh',
        material,
        runtimeVersion: 'test',
        schemaVersion: 1,
        segments: [{
          confidence: 0.8,
          endMs: 5_500,
          segmentId: 'outside',
          speaker: null,
          startMs: 4_900,
          text: '超出范围',
          words: [],
        }],
      },
      mediaKind: 'video',
      probe,
    })).toThrow('证据结束时间超出素材范围');
  });
});
