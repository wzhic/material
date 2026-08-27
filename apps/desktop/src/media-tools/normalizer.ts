import { createHash } from 'node:crypto';

import {
  StructuredEvidence,
  validateEvidenceBatch,
  VideoTimeLocator,
} from '../tooling/evidence';
import {
  MediaEvidenceOutput,
  MediaIdentity,
  MediaNormalizationInput,
  MediaToolCapabilityId,
  MediaToolError,
  TimelineEntry,
} from './contracts';

const stableId = (kind: string, value: string): string =>
  `${kind}-${createHash('sha256').update(value).digest('hex').slice(0, 20)}`;

export const frameEvidenceId = (frameId: string): string => stableId('frame', frameId);

const videoLocator = (
  startMs: number,
  endMs: number | null | undefined,
  durationMs: number,
): VideoTimeLocator => {
  const start = Math.round(startMs);
  const end = endMs === null || endMs === undefined ? undefined : Math.round(endMs);
  if (!Number.isSafeInteger(start) || start < 0 || start > durationMs) {
    throw new MediaToolError('RUNTIME_OUTPUT_INVALID', '证据起始时间超出素材范围');
  }
  if (
    end !== undefined &&
    (!Number.isSafeInteger(end) || end < start || end > durationMs)
  ) {
    throw new MediaToolError('RUNTIME_OUTPUT_INVALID', '证据结束时间超出素材范围');
  }
  return end !== undefined && end > start
    ? { endMs: end, kind: 'video_time', startMs: start }
    : { kind: 'video_time', startMs: start };
};

const source = (capabilityId: string) => ({
  capabilityId,
  kind: 'tool' as const,
  version: '1.0.0',
});

const sameMaterial = (left: MediaIdentity, right: MediaIdentity): boolean =>
  left.fingerprintAlgorithm === right.fingerprintAlgorithm &&
  left.fingerprintSha256 === right.fingerprintSha256 &&
  left.kind === right.kind &&
  left.size === right.size;

const assertMaterial = (
  expected: MediaIdentity,
  capabilityId: MediaToolCapabilityId,
  actual: MediaIdentity,
): void => {
  if (!sameMaterial(expected, actual)) {
    throw new MediaToolError(
      'SOURCE_CHANGED',
      `${capabilityId} 的结果不属于当前素材`,
    );
  }
};

const evidenceTimeline = (evidence: StructuredEvidence): TimelineEntry => {
  if (evidence.locator.kind !== 'video_time') {
    return { endMs: null, evidenceId: evidence.evidenceId, startMs: 0, track: 'ocr' };
  }
  const track: TimelineEntry['track'] = evidence.evidenceType.startsWith('visual.shot')
    ? 'shot'
    : evidence.evidenceType.startsWith('text.ocr')
      ? 'ocr'
      : evidence.evidenceType.startsWith('speech.')
        ? 'speech'
        : 'audio';
  return {
    endMs: evidence.locator.endMs ?? null,
    evidenceId: evidence.evidenceId,
    startMs: evidence.locator.startMs,
    track,
  };
};

const technicalDescription = (input: MediaNormalizationInput): string => {
  const visual = input.probe.streams.find((stream) => stream.kind === 'video');
  const dimensions = visual?.width && visual.height
    ? `${visual.width}×${visual.height}`
    : '分辨率未知';
  if (input.mediaKind === 'image') {
    return `图片技术信息：${dimensions}；该证据只证明素材可读取，不包含画面语义`;
  }
  return `视频技术信息：时长 ${input.probe.durationMs} ms，${dimensions}，${
    input.probe.hasAudio ? '包含音轨' : '没有音轨'
  }；该证据不包含画面语义`;
};

export const normalizeMediaEvidence = (
  input: MediaNormalizationInput,
): MediaEvidenceOutput => {
  if (input.probe.mediaKind !== input.mediaKind) {
    throw new MediaToolError('RUNTIME_OUTPUT_INVALID', '媒体探测结果与归一化类型不一致');
  }
  if (input.probe.material.kind !== input.mediaKind) {
    throw new MediaToolError('RUNTIME_OUTPUT_INVALID', '素材身份与媒体类型不一致');
  }
  const material = input.probe.material;
  if (input.frames) assertMaterial(material, 'media.frame.extract', input.frames.material);
  if (input.shots) assertMaterial(material, 'media.shot.detect', input.shots.material);
  if (input.ocr) assertMaterial(material, 'media.ocr', input.ocr.material);
  if (input.audio) assertMaterial(material, 'media.audio.extract', input.audio.material);
  if (input.asr) assertMaterial(material, 'media.asr', input.asr.material);
  if (input.audioEvents) {
    assertMaterial(material, 'media.audio.event', input.audioEvents.material);
  }
  const durationMs = input.mediaKind === 'video' ? input.probe.durationMs : 0;
  for (const frame of input.frames?.frames ?? []) {
    if (
      frame.width < 1 ||
      frame.height < 1 ||
      frame.timeMs < 0 ||
      (input.mediaKind === 'video' && frame.timeMs > durationMs) ||
      (input.mediaKind === 'image' && frame.timeMs !== 0)
    ) {
      throw new MediaToolError('RUNTIME_OUTPUT_INVALID', '代表帧元数据超出素材范围');
    }
  }
  if (
    input.mediaKind === 'image' &&
    (input.shots || input.audio || input.asr || input.audioEvents)
  ) {
    throw new MediaToolError('RUNTIME_OUTPUT_INVALID', '图片不能包含视频或音频分析结果');
  }
  if (input.mediaKind === 'video') {
    for (const shot of input.shots?.shots ?? []) {
      videoLocator(shot.startMs, shot.endMs, durationMs);
      if (shot.endMs <= shot.startMs || shot.keyframeMs < shot.startMs || shot.keyframeMs >= shot.endMs) {
        throw new MediaToolError('RUNTIME_OUTPUT_INVALID', '镜头候选时间关系无效');
      }
    }
    for (const segment of input.ocr?.segments ?? []) {
      if (segment.startMs === null) {
        throw new MediaToolError('RUNTIME_OUTPUT_INVALID', '视频 OCR 缺少时间点');
      }
      videoLocator(segment.startMs, segment.endMs, durationMs);
    }
    if (input.audio && input.audio.hasAudio !== input.probe.hasAudio) {
      throw new MediaToolError('RUNTIME_OUTPUT_INVALID', '音轨分析结果与媒体探测不一致');
    }
    let previousWaveformEnd = 0;
    for (const point of input.audio?.waveform ?? []) {
      videoLocator(point.startMs, point.endMs, durationMs);
      if (point.endMs <= point.startMs || point.startMs < previousWaveformEnd) {
        throw new MediaToolError('RUNTIME_OUTPUT_INVALID', '波形时间桶无效或重叠');
      }
      previousWaveformEnd = point.endMs;
    }
    if (!input.probe.hasAudio && (input.asr?.segments.length || input.audioEvents?.events.length)) {
      throw new MediaToolError('RUNTIME_OUTPUT_INVALID', '无音轨素材不能包含语音或声音事件');
    }
    for (const segment of input.asr?.segments ?? []) {
      videoLocator(segment.startMs, segment.endMs, durationMs);
      for (const word of segment.words) {
        videoLocator(word.startMs, word.endMs, durationMs);
        if (word.startMs < segment.startMs || word.endMs > segment.endMs) {
          throw new MediaToolError('RUNTIME_OUTPUT_INVALID', '词级时间超出语音片段');
        }
      }
    }
    for (const event of input.audioEvents?.events ?? []) {
      videoLocator(event.startMs, event.endMs, durationMs);
    }
  } else {
    for (const segment of input.ocr?.segments ?? []) {
      if (segment.startMs !== null || segment.endMs !== null) {
        throw new MediaToolError('RUNTIME_OUTPUT_INVALID', '图片 OCR 不应包含视频时间');
      }
    }
  }
  const evidence: StructuredEvidence[] = [];
  const limitations: string[] = [];

  evidence.push({
    confidence: 1,
    evidenceId: stableId('probe', material.fingerprintSha256),
    evidenceType: 'metadata.media',
    locator: input.mediaKind === 'video'
      ? { kind: 'video_time', startMs: 0 }
      : { height: 1, kind: 'image_region', width: 1, x: 0, y: 0 },
    mediaKind: input.mediaKind,
    schemaVersion: 1,
    source: source('media.probe'),
    text: technicalDescription(input),
  });

  for (const frame of input.frames?.frames ?? []) {
    evidence.push({
      confidence: 1,
      evidenceId: frameEvidenceId(frame.frameId),
      evidenceType: 'metadata.frame.sample',
      locator: input.mediaKind === 'video'
        ? { kind: 'video_time', startMs: frame.timeMs }
        : { height: 1, kind: 'image_region', width: 1, x: 0, y: 0 },
      mediaKind: input.mediaKind,
      schemaVersion: 1,
      source: source('media.frame.extract'),
      text: `已抽取 ${frame.width}×${frame.height} 代表帧；该证据只证明采样位置，不包含画面语义`,
    });
  }

  if (input.mediaKind === 'video') {
    if (input.shots) {
      for (const [index, shot] of input.shots.shots.entries()) {
        evidence.push({
          confidence: shot.confidence,
          evidenceId: stableId('shot', `${shot.startMs}:${shot.endMs}:${index}`),
          evidenceType: 'visual.shot.candidate',
          locator: videoLocator(shot.startMs, shot.endMs, durationMs),
          mediaKind: 'video',
          schemaVersion: 1,
          source: source('media.shot.detect'),
          text: `镜头候选 ${index + 1}`,
        });
      }
    } else {
      limitations.push('未提供镜头检测结果');
    }
  }

  if (input.ocr) {
    for (const segment of input.ocr.segments) {
      const locator = input.mediaKind === 'image'
        ? { ...segment.region, kind: 'image_region' as const }
        : videoLocator(segment.startMs ?? 0, segment.endMs, durationMs);
      evidence.push({
        confidence: segment.confidence,
        evidenceId: stableId('ocr', `${segment.segmentId}:${segment.text}`),
        evidenceType: 'text.ocr',
        locator,
        mediaKind: input.mediaKind,
        schemaVersion: 1,
        source: source('media.ocr'),
        text: segment.text,
      });
    }
  } else {
    limitations.push('未提供 OCR 结果');
  }

  if (input.mediaKind === 'video') {
    if (!input.probe.hasAudio) {
      limitations.push('素材没有音轨');
    }
    if (input.audio) {
      for (const interval of input.audio.silence) {
        evidence.push({
          confidence: 1,
          evidenceId: stableId('silence', `${interval.startMs}:${interval.endMs}`),
          evidenceType: 'audio.silence',
          locator: videoLocator(interval.startMs, interval.endMs, durationMs),
          mediaKind: 'video',
          schemaVersion: 1,
          source: source('media.audio.extract'),
          text: '静音区间',
        });
      }
    } else if (input.probe.hasAudio) {
      limitations.push('未提供音轨基础特征');
    }
    if (input.asr) {
      for (const segment of input.asr.segments) {
        evidence.push({
          confidence: segment.confidence,
          evidenceId: stableId('asr', `${segment.segmentId}:${segment.text}`),
          evidenceType: 'speech.transcript',
          locator: videoLocator(segment.startMs, segment.endMs, durationMs),
          mediaKind: 'video',
          schemaVersion: 1,
          source: source('media.asr'),
          text: segment.text,
        });
      }
    } else if (input.probe.hasAudio) {
      limitations.push('未提供 ASR 结果');
    }
    if (input.audioEvents) {
      limitations.push(...input.audioEvents.limitations);
      for (const event of input.audioEvents.events) {
        evidence.push({
          confidence: event.confidence,
          evidenceId: stableId('audio-event', `${event.eventId}:${event.label}`),
          evidenceType: `audio.event.${event.eventType}`,
          locator: videoLocator(event.startMs, event.endMs, durationMs),
          mediaKind: 'video',
          schemaVersion: 1,
          source: source('media.audio.event'),
          text: event.label,
        });
      }
    } else if (input.probe.hasAudio) {
      limitations.push('未提供声音事件结果');
    }
  }

  evidence.sort((left, right) => {
    const leftStart = left.locator.kind === 'video_time' ? left.locator.startMs : 0;
    const rightStart = right.locator.kind === 'video_time' ? right.locator.startMs : 0;
    return leftStart - rightStart || left.evidenceType.localeCompare(right.evidenceType);
  });
  const validation = validateEvidenceBatch(evidence, {
    durationMs: input.mediaKind === 'video' ? durationMs : undefined,
    mediaKind: input.mediaKind,
  });
  if (!validation.ok) {
    throw new MediaToolError('RUNTIME_OUTPUT_INVALID', '归一化证据未通过结构校验');
  }
  const provenance: MediaEvidenceOutput['provenance'] = [
    {
      capabilityId: 'media.probe',
      runtimeVersion: input.probe.probeVersion,
      schemaVersion: 1,
    },
    ...(input.frames ? [{
      capabilityId: 'media.frame.extract' as const,
      runtimeVersion: input.frames.runtimeVersion,
      schemaVersion: 1 as const,
    }] : []),
    ...(input.shots ? [{
      capabilityId: 'media.shot.detect' as const,
      runtimeVersion: input.shots.runtimeVersion,
      schemaVersion: 1 as const,
    }] : []),
    ...(input.ocr ? [{
      capabilityId: 'media.ocr' as const,
      runtimeVersion: input.ocr.runtimeVersion,
      schemaVersion: 1 as const,
    }] : []),
    ...(input.audio ? [{
      capabilityId: 'media.audio.extract' as const,
      runtimeVersion: input.audio.runtimeVersion,
      schemaVersion: 1 as const,
    }] : []),
    ...(input.asr ? [{
      capabilityId: 'media.asr' as const,
      runtimeVersion: input.asr.runtimeVersion,
      schemaVersion: 1 as const,
    }] : []),
    ...(input.audioEvents ? [{
      capabilityId: 'media.audio.event' as const,
      runtimeVersion: input.audioEvents.runtimeVersion,
      schemaVersion: 1 as const,
    }] : []),
    {
      capabilityId: 'media.evidence.normalize',
      runtimeVersion: '1.0.0',
      schemaVersion: 1,
    },
  ];
  return {
    evidence,
    limitations: [...new Set(limitations)],
    material,
    provenance,
    schemaVersion: 1,
    timeline: input.mediaKind === 'video'
      ? evidence
        .filter((item) => !item.evidenceType.startsWith('metadata.'))
        .map(evidenceTimeline)
      : [],
  };
};
