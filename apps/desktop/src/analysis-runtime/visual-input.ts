import type { FrameExtractionOutput } from '../media-tools';
import { frameEvidenceId } from '../media-tools';
import type { ModelVisualInput } from '../model/types';
import type { ToolArtifact, ToolInvocationSuccess } from '../tooling/types';

export const VISUAL_INPUT_LIMITS = Object.freeze({
  jpegQuality: 80,
  maxDimension: 1_280,
  maxImageBytes: 1024 * 1024,
  maxImages: 8,
  maxTotalBytes: 6 * 1024 * 1024,
});

export interface EncodedVisualImage {
  bytes: Uint8Array;
  height: number;
  width: number;
}

export interface VisualImageCodec {
  encodeJpeg(
    source: Uint8Array,
    options: { maxBytes: number; maxDimension: number; quality: number },
  ): EncodedVisualImage;
}

export interface VisualArtifactReader {
  readArtifact(invocationId: string, artifactId: string): Promise<Uint8Array>;
}

const resolveArtifact = (
  artifacts: readonly ToolArtifact[],
  relativePath: string,
): ToolArtifact => {
  const matches = artifacts.filter((artifact) => artifact.relativePath === relativePath);
  if (matches.length !== 1 || !matches[0].mediaType.startsWith('image/')) {
    throw new Error('visual frame artifact is missing or ambiguous');
  }
  return matches[0];
};

export class VisualInputPreparer {
  constructor(
    private readonly artifacts: VisualArtifactReader,
    private readonly codec: VisualImageCodec,
  ) {}

  async prepare(
    invocation: ToolInvocationSuccess,
    frames: FrameExtractionOutput,
    mediaKind: 'image' | 'video',
  ): Promise<ModelVisualInput[]> {
    if (
      invocation.capability.capabilityId !== 'media.frame.extract'
      || frames.frames.length < 1
      || frames.frames.length > VISUAL_INPUT_LIMITS.maxImages
    ) {
      throw new Error('visual frame invocation is invalid');
    }
    const maxBytes = Math.min(
      VISUAL_INPUT_LIMITS.maxImageBytes,
      Math.floor(VISUAL_INPUT_LIMITS.maxTotalBytes / frames.frames.length),
    );
    const visualInputs: ModelVisualInput[] = [];
    let totalBytes = 0;
    for (const frame of frames.frames) {
      const artifact = resolveArtifact(invocation.artifacts, frame.artifactRelativePath);
      const source = await this.artifacts.readArtifact(invocation.invocationId, artifact.artifactId);
      const encoded = this.codec.encodeJpeg(source, {
        maxBytes,
        maxDimension: VISUAL_INPUT_LIMITS.maxDimension,
        quality: VISUAL_INPUT_LIMITS.jpegQuality,
      });
      if (
        encoded.bytes.length < 1
        || encoded.bytes.length > maxBytes
        || !Number.isSafeInteger(encoded.width)
        || !Number.isSafeInteger(encoded.height)
        || encoded.width < 1
        || encoded.height < 1
        || encoded.width > VISUAL_INPUT_LIMITS.maxDimension
        || encoded.height > VISUAL_INPUT_LIMITS.maxDimension
      ) {
        throw new Error('encoded visual frame exceeds the controlled limits');
      }
      totalBytes += encoded.bytes.length;
      if (totalBytes > VISUAL_INPUT_LIMITS.maxTotalBytes) {
        throw new Error('visual frame batch exceeds the controlled limits');
      }
      visualInputs.push({
        dataBase64: Buffer.from(encoded.bytes).toString('base64'),
        evidenceId: frameEvidenceId(frame.frameId),
        height: encoded.height,
        mediaType: 'image/jpeg',
        timeMs: mediaKind === 'video' ? frame.timeMs : null,
        width: encoded.width,
      });
    }
    return visualInputs;
  }
}
