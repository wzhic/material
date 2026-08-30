import type { LocalMaterialSummary } from '../media/types';
import type { StructuredEvidence } from '../tooling/evidence';

export type MediaToolCapabilityId =
  | 'media.probe'
  | 'media.frame.extract'
  | 'media.shot.detect'
  | 'media.ocr'
  | 'media.audio.extract'
  | 'media.asr'
  | 'media.audio.event'
  | 'media.evidence.normalize';

export interface MediaToolSource {
  filePath: string;
  modifiedAtMs: number;
  summary: LocalMaterialSummary;
}

export interface MediaToolSourceResolver {
  resolve(sessionId: string): Promise<MediaToolSource>;
}

export interface RuntimeCapabilityHealth {
  available: boolean;
  capabilityId: MediaToolCapabilityId;
  detail: string;
  runtimeVersion: string | null;
}

export interface MediaIdentity {
  fingerprintAlgorithm: LocalMaterialSummary['fingerprintAlgorithm'];
  fingerprintSha256: string;
  kind: LocalMaterialSummary['kind'];
  size: number;
}

export const mediaIdentity = (source: MediaToolSource): MediaIdentity => ({
  fingerprintAlgorithm: source.summary.fingerprintAlgorithm,
  fingerprintSha256: source.summary.fingerprintSha256,
  kind: source.summary.kind,
  size: source.summary.size,
});

export interface MediaProbeStream {
  bitRate: number | null;
  channels: number | null;
  codecName: string;
  durationMs: number | null;
  frameRate: number | null;
  height: number | null;
  index: number;
  kind: 'audio' | 'data' | 'subtitle' | 'video';
  language: string | null;
  rotationDegrees: number;
  sampleRate: number | null;
  timeBase: string | null;
  width: number | null;
}

export interface MediaProbeOutput {
  bitRate: number | null;
  durationMs: number;
  formatNames: readonly string[];
  hasAudio: boolean;
  hasVideo: boolean;
  material: MediaIdentity;
  mediaKind: 'image' | 'video';
  probeVersion: string;
  schemaVersion: 1;
  startTimeMs: number;
  streams: readonly MediaProbeStream[];
}

export interface ExtractedFrame {
  artifactRelativePath: string;
  frameId: string;
  height: number;
  purpose: 'representative' | 'specified' | 'thumbnail';
  timeMs: number;
  width: number;
}

export interface FrameExtractionOutput {
  frames: readonly ExtractedFrame[];
  material: MediaIdentity;
  runtimeVersion: string;
  schemaVersion: 1;
}

export interface ShotCandidate {
  confidence: number;
  endMs: number;
  keyframeMs: number;
  shotId: string;
  startMs: number;
}

export interface ShotDetectionOutput {
  algorithm: 'ffmpeg-scene-v1';
  material: MediaIdentity;
  runtimeVersion: string;
  schemaVersion: 1;
  shots: readonly ShotCandidate[];
  threshold: number;
}

export interface NormalizedRegion {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface OcrSegment {
  confidence: number;
  endMs: number | null;
  region: NormalizedRegion;
  segmentId: string;
  startMs: number | null;
  text: string;
}

export interface OcrOutput {
  language: string;
  material: MediaIdentity;
  runtimeVersion: string;
  schemaVersion: 1;
  segments: readonly OcrSegment[];
}

export interface SilenceInterval {
  endMs: number;
  startMs: number;
}

export interface WaveformPoint {
  endMs: number;
  peak: number;
  startMs: number;
}

export interface AudioExtractionOutput {
  artifactRelativePath: string | null;
  channels: number;
  hasAudio: boolean;
  integratedLoudnessLufs: number | null;
  maxVolumeDb: number | null;
  meanVolumeDb: number | null;
  material: MediaIdentity;
  runtimeVersion: string;
  sampleRate: number;
  schemaVersion: 1;
  silence: readonly SilenceInterval[];
  waveform: readonly WaveformPoint[];
}

export interface AsrWord {
  confidence: number;
  endMs: number;
  startMs: number;
  text: string;
}

export interface AsrSegment {
  confidence: number;
  endMs: number;
  segmentId: string;
  speaker: string | null;
  startMs: number;
  text: string;
  words: readonly AsrWord[];
}

export interface AsrOutput {
  detectedLanguage: string | null;
  material: MediaIdentity;
  runtimeVersion: string;
  schemaVersion: 1;
  segments: readonly AsrSegment[];
}

export interface AudioEvent {
  confidence: number;
  endMs: number;
  eventId: string;
  eventType: 'effect' | 'music' | 'other' | 'speech';
  label: string;
  startMs: number;
}

export interface AudioEventOutput {
  events: readonly AudioEvent[];
  limitations: readonly string[];
  material: MediaIdentity;
  modelVersion: string;
  runtimeVersion: string;
  schemaVersion: 1;
}

export interface MediaNormalizationInput {
  asr?: AsrOutput;
  audio?: AudioExtractionOutput;
  audioEvents?: AudioEventOutput;
  frames?: FrameExtractionOutput;
  mediaKind: 'image' | 'video';
  ocr?: OcrOutput;
  probe: MediaProbeOutput;
  shots?: ShotDetectionOutput;
}

export interface TimelineEntry {
  endMs: number | null;
  evidenceId: string;
  startMs: number;
  track: 'audio' | 'ocr' | 'shot' | 'speech';
}

export interface MediaEvidenceOutput {
  evidence: readonly StructuredEvidence[];
  limitations: readonly string[];
  material: MediaIdentity;
  provenance: readonly {
    capabilityId: MediaToolCapabilityId;
    runtimeVersion: string;
    schemaVersion: 1;
  }[];
  schemaVersion: 1;
  timeline: readonly TimelineEntry[];
}

export class MediaToolError extends Error {
  constructor(
    readonly code:
      | 'INVALID_MEDIA'
      | 'RUNTIME_MISSING'
      | 'RUNTIME_OUTPUT_INVALID'
      | 'SOURCE_CHANGED'
      | 'UNSUPPORTED_MEDIA',
    message: string,
  ) {
    super(message);
    this.name = 'MediaToolError';
  }
}
