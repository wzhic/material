import { describe, expect, it } from 'vitest';

import { AnalysisEngineError } from './errors';
import { buildEvidencePacket } from './evidence-packet';
import type { MediaEvidenceOutput } from '../media-tools';
import type { StructuredEvidence } from '../tooling/evidence';

const videoEvidence = (index: number, value = `画面证据 ${index}`): StructuredEvidence => ({
  confidence: 0.9,
  evidenceId: `evidence-${index}`,
  evidenceType: 'visual',
  locator: { endMs: index + 1, kind: 'video_time', startMs: index },
  mediaKind: 'video',
  schemaVersion: 1,
  source: { capabilityId: 'media.frame.extract', kind: 'tool', version: '1.0.0' },
  text: value,
});

const mediaOutput = (evidence: readonly StructuredEvidence[]): MediaEvidenceOutput => ({
  evidence,
  limitations: ['当前未启用音频事件模型'],
  material: {
    fingerprintAlgorithm: 'sha256-full-v1',
    fingerprintSha256: 'a'.repeat(64),
    kind: 'video',
    size: 123,
  },
  provenance: [{
    capabilityId: 'media.evidence.normalize',
    runtimeVersion: '1.0.0',
    schemaVersion: 1,
  }],
  schemaVersion: 1,
  timeline: [{ endMs: 1_000, evidenceId: 'timeline-only', startMs: 0, track: 'shot' }],
});

describe('analysis evidence packet', () => {
  it('keeps validated evidence references and removes no source facts', () => {
    const packet = buildEvidencePacket(mediaOutput([videoEvidence(1)]));

    expect(packet.items).toHaveLength(1);
    expect(packet.includedEvidenceIds.has('evidence-1')).toBe(true);
    expect(packet.items[0].source.kind).toBe('tool');
    expect(packet.limitations).toContain('当前未启用音频事件模型');
  });

  it('makes sampling and long-text truncation visible', () => {
    const evidence = Array.from({ length: 301 }, (_, index) =>
      videoEvidence(index, index === 0 ? '长'.repeat(900) : `证据 ${index}`),
    );
    const packet = buildEvidencePacket(mediaOutput(evidence));

    expect(packet.items.length).toBeLessThanOrEqual(300);
    expect(packet.omittedEvidenceCount).toBeGreaterThan(0);
    expect(packet.truncatedTextCount).toBe(1);
    expect(packet.limitations.some((item) => item.includes('未发送'))).toBe(true);
    expect(packet.limitations.some((item) => item.includes('截断'))).toBe(true);
  });

  it('rejects empty, version-invalid and out-of-range evidence before model use', () => {
    expect(() => buildEvidencePacket(mediaOutput([]))).toThrowError(AnalysisEngineError);
    expect(() => buildEvidencePacket({
      ...mediaOutput([videoEvidence(1)]),
      schemaVersion: 2 as 1,
    })).toThrowError(/不支持/);
    expect(() => buildEvidencePacket(mediaOutput([{
      ...videoEvidence(1),
      locator: { endMs: 1_200, kind: 'video_time', startMs: 1_100 },
    }]))).toThrowError(/未通过/);
  });
});
