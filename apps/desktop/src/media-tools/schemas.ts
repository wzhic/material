import type { ObjectSchema, ValueSchema } from '../tooling/types';

const object = (
  properties: Record<string, ValueSchema>,
  required: readonly string[] = Object.keys(properties),
): ObjectSchema => ({ additionalProperties: false, properties, required, type: 'object' });

const string = (maxLength = 240): ValueSchema => ({ maxLength, type: 'string' });
const number = (minimum?: number, maximum?: number, integer = false): ValueSchema => ({
  integer,
  maximum,
  minimum,
  type: 'number',
});
const nullable = (schema: ValueSchema): ValueSchema => ({ anyOf: [schema, { type: 'null' }] });
const array = (items: ValueSchema, maxItems: number): ValueSchema => ({
  items,
  maxItems,
  type: 'array',
});

export const sessionInputSchema = (
  extra: Record<string, ValueSchema> = {},
  requiredExtra: readonly string[] = [],
): ObjectSchema =>
  object(
    {
      sessionId: { maxLength: 36, minLength: 36, pattern: '^[0-9a-fA-F-]{36}$', type: 'string' },
      ...extra,
    },
    ['sessionId', ...requiredExtra],
  );

const materialIdentitySchema = object({
  fingerprintAlgorithm: { enum: ['sha256-full-v1'], type: 'string' },
  fingerprintSha256: { maxLength: 64, minLength: 64, pattern: '^[a-f0-9]{64}$', type: 'string' },
  kind: { enum: ['image', 'video'], type: 'string' },
  size: number(0, Number.MAX_SAFE_INTEGER, true),
});

const streamSchema = object({
  bitRate: nullable(number(0, undefined, true)),
  channels: nullable(number(0, 128, true)),
  codecName: string(80),
  durationMs: nullable(number(0, undefined, true)),
  frameRate: nullable(number(0, 1000)),
  height: nullable(number(1, 100_000, true)),
  index: number(0, 10_000, true),
  kind: { enum: ['audio', 'data', 'subtitle', 'video'], type: 'string' },
  language: nullable(string(32)),
  rotationDegrees: number(0, 359, true),
  sampleRate: nullable(number(1, 1_000_000, true)),
  timeBase: nullable(string(40)),
  width: nullable(number(1, 100_000, true)),
});

export const probeOutputSchema = object({
  bitRate: nullable(number(0, undefined, true)),
  durationMs: number(0, undefined, true),
  formatNames: array(string(80), 32),
  hasAudio: { type: 'boolean' },
  hasVideo: { type: 'boolean' },
  material: materialIdentitySchema,
  mediaKind: { enum: ['image', 'video'], type: 'string' },
  probeVersion: string(120),
  schemaVersion: number(1, 1, true),
  startTimeMs: number(0, undefined, true),
  streams: array(streamSchema, 256),
});

const frameSchema = object({
  artifactRelativePath: string(512),
  frameId: string(128),
  height: number(1, 100_000, true),
  purpose: { enum: ['representative', 'specified', 'thumbnail'], type: 'string' },
  timeMs: number(0, undefined, true),
  width: number(1, 100_000, true),
});

export const frameOutputSchema = object({
  frames: array(frameSchema, 32),
  material: materialIdentitySchema,
  runtimeVersion: string(120),
  schemaVersion: number(1, 1, true),
});

const shotSchema = object({
  confidence: number(0, 1),
  endMs: number(1, undefined, true),
  keyframeMs: number(0, undefined, true),
  shotId: string(128),
  startMs: number(0, undefined, true),
});

export const shotOutputSchema = object({
  algorithm: { enum: ['ffmpeg-scene-v1'], type: 'string' },
  material: materialIdentitySchema,
  runtimeVersion: string(120),
  schemaVersion: number(1, 1, true),
  shots: array(shotSchema, 20_000),
  threshold: number(0.05, 0.95),
});

const regionSchema = object({
  height: number(0, 1),
  width: number(0, 1),
  x: number(0, 1),
  y: number(0, 1),
});

const ocrSegmentSchema = object({
  confidence: number(0, 1),
  endMs: nullable(number(0, undefined, true)),
  region: regionSchema,
  segmentId: string(128),
  startMs: nullable(number(0, undefined, true)),
  text: string(10_000),
});

export const ocrOutputSchema = object({
  language: string(32),
  material: materialIdentitySchema,
  runtimeVersion: string(120),
  schemaVersion: number(1, 1, true),
  segments: array(ocrSegmentSchema, 20_000),
});

const silenceSchema = object({
  endMs: number(1, undefined, true),
  startMs: number(0, undefined, true),
});
const waveformSchema = object({
  endMs: number(0, undefined, true),
  peak: number(0, 1),
  startMs: number(0, undefined, true),
});

export const audioOutputSchema = object({
  artifactRelativePath: nullable(string(512)),
  channels: number(0, 128, true),
  hasAudio: { type: 'boolean' },
  integratedLoudnessLufs: nullable(number(-300, 100)),
  maxVolumeDb: nullable(number(-300, 100)),
  meanVolumeDb: nullable(number(-300, 100)),
  material: materialIdentitySchema,
  runtimeVersion: string(120),
  sampleRate: number(0, 1_000_000, true),
  schemaVersion: number(1, 1, true),
  silence: array(silenceSchema, 20_000),
  waveform: array(waveformSchema, 2_000),
});

const asrWordSchema = object({
  confidence: number(0, 1),
  endMs: number(1, undefined, true),
  startMs: number(0, undefined, true),
  text: string(500),
});
const asrSegmentSchema = object({
  confidence: number(0, 1),
  endMs: number(1, undefined, true),
  segmentId: string(128),
  speaker: nullable(string(80)),
  startMs: number(0, undefined, true),
  text: string(10_000),
  words: array(asrWordSchema, 10_000),
});

export const asrOutputSchema = object({
  detectedLanguage: nullable(string(32)),
  material: materialIdentitySchema,
  runtimeVersion: string(120),
  schemaVersion: number(1, 1, true),
  segments: array(asrSegmentSchema, 20_000),
});

const audioEventSchema = object({
  confidence: number(0, 1),
  endMs: number(1, undefined, true),
  eventId: string(128),
  eventType: { enum: ['effect', 'music', 'other', 'speech'], type: 'string' },
  label: string(240),
  startMs: number(0, undefined, true),
});

export const audioEventOutputSchema = object({
  events: array(audioEventSchema, 20_000),
  limitations: array(string(500), 32),
  material: materialIdentitySchema,
  modelVersion: string(120),
  runtimeVersion: string(120),
  schemaVersion: number(1, 1, true),
});

const videoLocatorSchema = object(
  {
    endMs: number(0, undefined, true),
    kind: { enum: ['video_time'], type: 'string' },
    startMs: number(0, undefined, true),
  },
  ['kind', 'startMs'],
);
const imageLocatorSchema = object({
  height: number(0, 1),
  kind: { enum: ['image_region'], type: 'string' },
  width: number(0, 1),
  x: number(0, 1),
  y: number(0, 1),
});
const evidenceSchema = object({
  confidence: number(0, 1),
  evidenceId: string(128),
  evidenceType: string(160),
  locator: { anyOf: [videoLocatorSchema, imageLocatorSchema] },
  mediaKind: { enum: ['image', 'video'], type: 'string' },
  schemaVersion: number(1, 1, true),
  source: object({
    capabilityId: string(120),
    kind: { enum: ['tool'], type: 'string' },
    version: string(40),
  }),
  text: string(10_000),
});
const timelineSchema = object({
  endMs: nullable(number(0, undefined, true)),
  evidenceId: string(128),
  startMs: number(0, undefined, true),
  track: { enum: ['audio', 'ocr', 'shot', 'speech'], type: 'string' },
});
const provenanceSchema = object({
  capabilityId: {
    enum: [
      'media.probe',
      'media.frame.extract',
      'media.shot.detect',
      'media.ocr',
      'media.audio.extract',
      'media.asr',
      'media.audio.event',
      'media.evidence.normalize',
    ],
    type: 'string',
  },
  runtimeVersion: string(120),
  schemaVersion: number(1, 1, true),
});

export const evidenceOutputSchema = object({
  evidence: array(evidenceSchema, 100_000),
  limitations: array(string(500), 128),
  material: materialIdentitySchema,
  provenance: array(provenanceSchema, 8),
  schemaVersion: number(1, 1, true),
  timeline: array(timelineSchema, 100_000),
});

export const normalizeInputSchema = object(
  {
    asr: asrOutputSchema,
    audio: audioOutputSchema,
    audioEvents: audioEventOutputSchema,
    frames: frameOutputSchema,
    mediaKind: { enum: ['image', 'video'], type: 'string' },
    ocr: ocrOutputSchema,
    probe: probeOutputSchema,
    shots: shotOutputSchema,
  },
  ['mediaKind', 'probe'],
);
