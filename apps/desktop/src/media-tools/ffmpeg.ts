import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';

import type { ToolWorkspace } from '../tooling/types';
import {
  AudioExtractionOutput,
  ExtractedFrame,
  FrameExtractionOutput,
  MediaProbeOutput,
  MediaProbeStream,
  MediaToolError,
  MediaToolSource,
  RuntimeCapabilityHealth,
  ShotCandidate,
  ShotDetectionOutput,
  WaveformPoint,
  mediaIdentity,
} from './contracts';
import {
  firstVersionLine,
  MediaProcessRunner,
  resolveExecutable,
  SpawnMediaProcessRunner,
} from './process';

interface FfprobeStream {
  avg_frame_rate?: string;
  bit_rate?: string;
  channels?: number;
  codec_name?: string;
  codec_type?: string;
  duration?: string;
  height?: number;
  index?: number;
  r_frame_rate?: string;
  sample_rate?: string;
  side_data_list?: Array<{ rotation?: number }>;
  tags?: { language?: string; rotate?: string };
  time_base?: string;
  width?: number;
}

interface FfprobePayload {
  format?: {
    bit_rate?: string;
    duration?: string;
    format_name?: string;
    start_time?: string;
  };
  streams?: FfprobeStream[];
}

export interface FfmpegRuntimeConfiguration {
  ffmpegPath?: string;
  ffprobePath?: string;
  pathValue?: string;
}

export interface FrameExtractionRequest {
  count?: number;
  maxDimension?: number;
  mode: 'representative' | 'specified' | 'thumbnail';
  timestampsMs?: readonly number[];
}

export interface ShotDetectionRequest {
  minimumShotMs?: number;
  threshold?: number;
}

const MAX_PROCESS_OUTPUT = 8 * 1024 * 1024;

const finiteNumber = (value: unknown): number | null => {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
};

const milliseconds = (value: unknown): number | null => {
  const seconds = finiteNumber(value);
  return seconds === null ? null : Math.max(0, Math.round(seconds * 1000));
};

const integer = (value: unknown): number | null => {
  const number = finiteNumber(value);
  return number === null ? null : Math.round(number);
};

const ratio = (value: string | undefined): number | null => {
  if (!value) return null;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }
  const result = numerator / denominator;
  return Number.isFinite(result) && result > 0 ? result : null;
};

const streamKind = (value: string | undefined): MediaProbeStream['kind'] =>
  value === 'video' || value === 'audio' || value === 'subtitle' ? value : 'data';

const normalizeRotation = (stream: FfprobeStream): number => {
  const raw =
    stream.side_data_list?.find((entry) => finiteNumber(entry.rotation) !== null)?.rotation ??
    stream.tags?.rotate ??
    0;
  const numeric = finiteNumber(raw) ?? 0;
  return ((Math.round(numeric) % 360) + 360) % 360;
};

const parseProbe = (
  payload: FfprobePayload,
  source: MediaToolSource,
  version: string,
): MediaProbeOutput => {
  const streams: MediaProbeStream[] = (payload.streams ?? []).map((stream, position) => ({
    bitRate: integer(stream.bit_rate),
    channels: integer(stream.channels),
    codecName: String(stream.codec_name ?? 'unknown').slice(0, 80),
    durationMs: milliseconds(stream.duration),
    frameRate: ratio(stream.avg_frame_rate) ?? ratio(stream.r_frame_rate),
    height: integer(stream.height),
    index: integer(stream.index) ?? position,
    kind: streamKind(stream.codec_type),
    language: stream.tags?.language?.slice(0, 32) ?? null,
    rotationDegrees: normalizeRotation(stream),
    sampleRate: integer(stream.sample_rate),
    timeBase: stream.time_base?.slice(0, 40) ?? null,
    width: integer(stream.width),
  }));
  const streamDuration = Math.max(0, ...streams.map((stream) => stream.durationMs ?? 0));
  const durationMs = milliseconds(payload.format?.duration) ?? streamDuration;
  if (source.summary.kind === 'video' && durationMs <= 0) {
    throw new MediaToolError('INVALID_MEDIA', '视频时长无法读取');
  }
  const hasVideo = streams.some((stream) => stream.kind === 'video');
  if (!hasVideo) throw new MediaToolError('UNSUPPORTED_MEDIA', '素材不包含可解析的画面轨道');
  return {
    bitRate: integer(payload.format?.bit_rate),
    durationMs,
    formatNames: String(payload.format?.format_name ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, 32),
    hasAudio: streams.some((stream) => stream.kind === 'audio'),
    hasVideo,
    material: mediaIdentity(source),
    mediaKind: source.summary.kind,
    probeVersion: version,
    schemaVersion: 1,
    startTimeMs: milliseconds(payload.format?.start_time) ?? 0,
    streams,
  };
};

const checked = async (
  runner: MediaProcessRunner,
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
  cwd?: string,
): Promise<{ stderr: Buffer; stdout: Buffer }> => {
  const result = await runner.run({
    args,
    cwd,
    executable,
    maxStderrBytes: MAX_PROCESS_OUTPUT,
    maxStdoutBytes: MAX_PROCESS_OUTPUT,
    signal,
  });
  if (result.exitCode !== 0) {
    throw new MediaToolError('INVALID_MEDIA', '媒体工具无法解析当前素材');
  }
  return result;
};

const stableId = (prefix: string, value: string): string =>
  `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;

const representativeTimes = (durationMs: number, count: number): number[] => {
  if (durationMs <= 0) return [0];
  if (count === 1) return [Math.min(durationMs - 1, Math.round(durationMs / 2))];
  const last = Math.max(0, durationMs - Math.min(50, Math.max(1, durationMs / 20)));
  return Array.from({ length: count }, (_unused, index) =>
    Math.round((last * index) / (count - 1)),
  );
};

const safeTimes = (values: readonly number[], durationMs: number): number[] =>
  [...new Set(values
    .map((value) => Math.round(value))
    .filter((value) => Number.isSafeInteger(value) && value >= 0 && value <= durationMs)
    .map((value) => durationMs > 0 && value === durationMs ? durationMs - 1 : value))]
    .sort((left, right) => left - right);

const fittedDimensions = (
  width: number,
  height: number,
  maximum: number,
): { height: number; width: number } => {
  if (width <= maximum && height <= maximum) return { height, width };
  const scale = Math.min(maximum / width, maximum / height);
  const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2);
  return { height: even(height * scale), width: even(width * scale) };
};

const parseSceneBoundaries = (stderr: string): Array<{ score: number; timeMs: number }> => {
  const results: Array<{ score: number; timeMs: number }> = [];
  let currentTime: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const time = /pts_time:([0-9.]+)/.exec(line);
    if (time) currentTime = Math.round(Number(time[1]) * 1000);
    const score = /lavfi\.scene_score=([0-9.]+)/.exec(line);
    if (score && currentTime !== null) {
      results.push({ score: Math.min(1, Math.max(0, Number(score[1]))), timeMs: currentTime });
      currentTime = null;
    }
  }
  return results;
};

const shotsFromBoundaries = (
  boundaries: Array<{ score: number; timeMs: number }>,
  durationMs: number,
  minimumShotMs: number,
): ShotCandidate[] => {
  const accepted: Array<{ score: number; timeMs: number }> = [{ score: 1, timeMs: 0 }];
  for (const boundary of boundaries.sort((left, right) => left.timeMs - right.timeMs)) {
    if (
      boundary.timeMs > 0 &&
      boundary.timeMs < durationMs &&
      boundary.timeMs - accepted[accepted.length - 1].timeMs >= minimumShotMs
    ) {
      accepted.push(boundary);
    }
  }
  if (durationMs - accepted[accepted.length - 1].timeMs < minimumShotMs && accepted.length > 1) {
    accepted.pop();
  }
  return accepted.map((boundary, index) => {
    const endMs = accepted[index + 1]?.timeMs ?? durationMs;
    const keyframeMs = Math.min(endMs - 1, Math.round((boundary.timeMs + endMs) / 2));
    return {
      confidence: index === 0 ? 1 : boundary.score,
      endMs,
      keyframeMs: Math.max(boundary.timeMs, keyframeMs),
      shotId: stableId('shot', `${boundary.timeMs}:${endMs}`),
      startMs: boundary.timeMs,
    };
  });
};

const parseSilence = (stderr: string, durationMs: number): Array<{ endMs: number; startMs: number }> => {
  const intervals: Array<{ endMs: number; startMs: number }> = [];
  let startMs: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const start = /silence_start:\s*([0-9.]+)/.exec(line);
    if (start) startMs = Math.max(0, Math.round(Number(start[1]) * 1000));
    const end = /silence_end:\s*([0-9.]+)/.exec(line);
    if (end && startMs !== null) {
      const endMs = Math.min(durationMs, Math.round(Number(end[1]) * 1000));
      if (endMs > startMs) intervals.push({ endMs, startMs });
      startMs = null;
    }
  }
  if (startMs !== null && durationMs > startMs) intervals.push({ endMs: durationMs, startMs });
  return intervals;
};

const findWavData = async (filePath: string): Promise<{ length: number; start: number }> => {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    if (bytesRead < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF') {
      throw new MediaToolError('RUNTIME_OUTPUT_INVALID', '音频中间文件格式无效');
    }
    let offset = 12;
    while (offset + 8 <= bytesRead) {
      const id = buffer.toString('ascii', offset, offset + 4);
      const size = buffer.readUInt32LE(offset + 4);
      if (id === 'data') return { length: size, start: offset + 8 };
      offset += 8 + size + (size % 2);
    }
    throw new MediaToolError('RUNTIME_OUTPUT_INVALID', '音频中间文件缺少数据区');
  } finally {
    await handle.close();
  }
};

const waveformFromWav = async (
  filePath: string,
  durationMs: number,
  pointCount: number,
): Promise<WaveformPoint[]> => {
  const data = await findWavData(filePath);
  const totalSamples = Math.floor(data.length / 2);
  const bucketSize = Math.max(1, Math.ceil(totalSamples / pointCount));
  const peaks: number[] = [];
  let peak = 0;
  let samples = 0;
  let carry: Buffer | null = null;
  const stream = createReadStream(filePath, {
    end: data.start + data.length - 1,
    start: data.start,
  });
  for await (const raw of stream) {
    const chunk: Buffer = carry
      ? Buffer.concat([carry, raw as Buffer])
      : (raw as Buffer);
    const usable: number = chunk.byteLength - (chunk.byteLength % 2);
    for (let offset = 0; offset < usable; offset += 2) {
      peak = Math.max(peak, Math.abs(chunk.readInt16LE(offset)) / 32768);
      samples += 1;
      if (samples === bucketSize) {
        peaks.push(Number(peak.toFixed(6)));
        peak = 0;
        samples = 0;
      }
    }
    carry = usable < chunk.byteLength ? chunk.subarray(usable) : null;
  }
  if (samples > 0) peaks.push(Number(peak.toFixed(6)));
  return peaks.map((value, index) => ({
    endMs: Math.round((durationMs * (index + 1)) / peaks.length),
    peak: value,
    startMs: Math.round((durationMs * index) / peaks.length),
  }));
};

export class FfmpegMediaTools {
  private ffmpeg: string | null = null;
  private ffprobe: string | null = null;
  private ffmpegVersion: string | null = null;
  private ffprobeVersion: string | null = null;

  constructor(
    private readonly configuration: FfmpegRuntimeConfiguration = {},
    private readonly runner: MediaProcessRunner = new SpawnMediaProcessRunner(),
  ) {}

  async health(): Promise<readonly RuntimeCapabilityHealth[]> {
    await this.resolveRuntimes();
    const ffmpeg = this.ffmpegVersion;
    const ffprobe = this.ffprobeVersion;
    return [
      'media.probe',
      'media.frame.extract',
      'media.shot.detect',
      'media.audio.extract',
    ].map((capabilityId) => ({
      available: capabilityId === 'media.probe' ? ffprobe !== null : ffmpeg !== null && ffprobe !== null,
      capabilityId: capabilityId as RuntimeCapabilityHealth['capabilityId'],
      detail:
        capabilityId === 'media.probe'
          ? ffprobe ? 'ffprobe 可用' : '未找到 ffprobe'
          : ffmpeg && ffprobe ? 'FFmpeg 工具链可用' : '未找到完整 FFmpeg 工具链',
      runtimeVersion: capabilityId === 'media.probe' ? ffprobe : ffmpeg,
    }));
  }

  async probe(source: MediaToolSource, signal?: AbortSignal): Promise<MediaProbeOutput> {
    await this.resolveRuntimes();
    if (!this.ffprobe || !this.ffprobeVersion) {
      throw new MediaToolError('RUNTIME_MISSING', '当前未安装或配置 ffprobe');
    }
    const { stdout } = await checked(
      this.runner,
      this.ffprobe,
      ['-v', 'error', '-show_format', '-show_streams', '-show_chapters', '-of', 'json', source.filePath],
      signal,
    );
    let payload: FfprobePayload;
    try {
      payload = JSON.parse(stdout.toString('utf8')) as FfprobePayload;
    } catch {
      throw new MediaToolError('RUNTIME_OUTPUT_INVALID', 'ffprobe 返回了无效结果');
    }
    return parseProbe(payload, source, this.ffprobeVersion);
  }

  async extractFrames(
    source: MediaToolSource,
    request: FrameExtractionRequest,
    workspace: ToolWorkspace,
    signal?: AbortSignal,
  ): Promise<FrameExtractionOutput> {
    await this.resolveRuntimes();
    if (!this.ffmpeg || !this.ffmpegVersion) {
      throw new MediaToolError('RUNTIME_MISSING', '当前未安装或配置 FFmpeg');
    }
    const probe = await this.probe(source, signal);
    const video = probe.streams.find((stream) => stream.kind === 'video');
    if (!video?.width || !video.height) {
      throw new MediaToolError('INVALID_MEDIA', '素材画面尺寸无法读取');
    }
    const count = Math.min(32, Math.max(1, Math.round(request.count ?? 8)));
    const maximum = Math.min(4096, Math.max(64, Math.round(request.maxDimension ?? 1280)));
    const requested =
      request.mode === 'specified'
        ? request.timestampsMs ?? []
        : request.mode === 'thumbnail'
          ? [probe.durationMs > 0 ? Math.round(probe.durationMs / 2) : 0]
          : representativeTimes(probe.durationMs, count);
    const times = safeTimes(requested, probe.durationMs);
    if (times.length === 0) throw new MediaToolError('INVALID_MEDIA', '没有合法的取帧时间点');
    const rotated = video.rotationDegrees === 90 || video.rotationDegrees === 270;
    const dimensions = fittedDimensions(
      rotated ? video.height : video.width,
      rotated ? video.width : video.height,
      maximum,
    );
    const frames: ExtractedFrame[] = [];
    for (const [index, timeMs] of times.entries()) {
      const relativePath = `frames/frame-${String(index + 1).padStart(3, '0')}.png`;
      const outputPath = path.join(workspace.directory, relativePath);
      await mkdir(path.dirname(outputPath), { recursive: true });
      await checked(
        this.runner,
        this.ffmpeg,
        [
          '-hide_banner', '-nostdin', '-loglevel', 'error', '-ss', (timeMs / 1000).toFixed(3),
          '-i', source.filePath, '-frames:v', '1', '-vf',
          `scale=${dimensions.width}:${dimensions.height}`,
          '-y', outputPath,
        ],
        signal,
        workspace.directory,
      );
      const artifact = await workspace.adoptArtifact(relativePath, 'image/png');
      frames.push({
        artifactRelativePath: artifact.relativePath,
        frameId: stableId('frame', `${source.summary.fingerprintSha256}:${timeMs}:${maximum}`),
        height: dimensions.height,
        purpose: request.mode,
        timeMs,
        width: dimensions.width,
      });
    }
    return {
      frames,
      material: mediaIdentity(source),
      runtimeVersion: this.ffmpegVersion,
      schemaVersion: 1,
    };
  }

  async detectShots(
    source: MediaToolSource,
    request: ShotDetectionRequest = {},
    signal?: AbortSignal,
  ): Promise<ShotDetectionOutput> {
    await this.resolveRuntimes();
    if (!this.ffmpeg || !this.ffmpegVersion) {
      throw new MediaToolError('RUNTIME_MISSING', '当前未安装或配置 FFmpeg');
    }
    const probe = await this.probe(source, signal);
    if (probe.mediaKind !== 'video') {
      throw new MediaToolError('UNSUPPORTED_MEDIA', '图片不支持镜头检测');
    }
    const threshold = Math.min(0.95, Math.max(0.05, request.threshold ?? 0.32));
    const minimumShotMs = Math.min(30_000, Math.max(100, Math.round(request.minimumShotMs ?? 300)));
    const filter = `select=gt(scene\\,${threshold.toFixed(4)}),metadata=print:key=lavfi.scene_score`;
    const { stderr } = await checked(
      this.runner,
      this.ffmpeg,
      ['-hide_banner', '-nostdin', '-i', source.filePath, '-vf', filter, '-an', '-f', 'null', '-'],
      signal,
    );
    const boundaries = parseSceneBoundaries(stderr.toString('utf8'));
    return {
      algorithm: 'ffmpeg-scene-v1',
      material: mediaIdentity(source),
      runtimeVersion: this.ffmpegVersion,
      schemaVersion: 1,
      shots: shotsFromBoundaries(boundaries, probe.durationMs, minimumShotMs),
      threshold,
    };
  }

  async extractAudio(
    source: MediaToolSource,
    workspace: ToolWorkspace,
    signal?: AbortSignal,
  ): Promise<AudioExtractionOutput> {
    await this.resolveRuntimes();
    if (!this.ffmpeg || !this.ffmpegVersion) {
      throw new MediaToolError('RUNTIME_MISSING', '当前未安装或配置 FFmpeg');
    }
    const probe = await this.probe(source, signal);
    if (!probe.hasAudio) {
      return {
        artifactRelativePath: null,
        channels: 0,
        hasAudio: false,
        integratedLoudnessLufs: null,
        maxVolumeDb: null,
        meanVolumeDb: null,
        material: mediaIdentity(source),
        runtimeVersion: this.ffmpegVersion,
        sampleRate: 0,
        schemaVersion: 1,
        silence: [],
        waveform: [],
      };
    }
    const relativePath = 'audio/source-16k-mono.wav';
    const outputPath = path.join(workspace.directory, relativePath);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await checked(
      this.runner,
      this.ffmpeg,
      [
        '-hide_banner', '-nostdin', '-loglevel', 'error', '-i', source.filePath, '-vn',
        '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', outputPath,
      ],
      signal,
      workspace.directory,
    );
    const artifact = await workspace.adoptArtifact(relativePath, 'audio/wav');
    const analysis = await checked(
      this.runner,
      this.ffmpeg,
      [
        '-hide_banner', '-nostdin', '-i', source.filePath, '-vn', '-af',
        'silencedetect=noise=-35dB:d=0.3,volumedetect,ebur128=metadata=0',
        '-f', 'null', '-',
      ],
      signal,
    );
    const stderr = analysis.stderr.toString('utf8');
    const mean = /mean_volume:\s*(-?[0-9.]+) dB/.exec(stderr);
    const max = /max_volume:\s*(-?[0-9.]+) dB/.exec(stderr);
    const loudnessMatches = [...stderr.matchAll(/(?:^|\s)I:\s*(-?[0-9.]+)\s+LUFS/g)];
    const integratedLoudness = loudnessMatches[loudnessMatches.length - 1];
    return {
      artifactRelativePath: artifact.relativePath,
      channels: 1,
      hasAudio: true,
      integratedLoudnessLufs: integratedLoudness ? Number(integratedLoudness[1]) : null,
      maxVolumeDb: max ? Number(max[1]) : null,
      meanVolumeDb: mean ? Number(mean[1]) : null,
      material: mediaIdentity(source),
      runtimeVersion: this.ffmpegVersion,
      sampleRate: 16_000,
      schemaVersion: 1,
      silence: parseSilence(stderr, probe.durationMs),
      waveform: await waveformFromWav(outputPath, probe.durationMs, 400),
    };
  }

  private async resolveRuntimes(): Promise<void> {
    if (this.ffmpeg === null) {
      this.ffmpeg = await resolveExecutable(
        'ffmpeg',
        this.configuration.ffmpegPath,
        this.configuration.pathValue,
      );
      this.ffmpegVersion = this.ffmpeg ? await this.version(this.ffmpeg) : null;
    }
    if (this.ffprobe === null) {
      this.ffprobe = await resolveExecutable(
        'ffprobe',
        this.configuration.ffprobePath,
        this.configuration.pathValue,
      );
      this.ffprobeVersion = this.ffprobe ? await this.version(this.ffprobe) : null;
    }
  }

  private async version(executable: string): Promise<string | null> {
    try {
      const result = await this.runner.run({
        args: ['-version'],
        executable,
        maxStderrBytes: 64 * 1024,
        maxStdoutBytes: 64 * 1024,
      });
      return result.exitCode === 0 ? firstVersionLine(result.stdout) : null;
    } catch {
      return null;
    }
  }
}
