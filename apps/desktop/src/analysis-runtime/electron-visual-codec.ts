import { nativeImage } from 'electron';

import type { EncodedVisualImage, VisualImageCodec } from './visual-input';

const MIN_DIMENSION = 256;
const QUALITIES = [80, 70, 60, 50, 40];

export class ElectronVisualImageCodec implements VisualImageCodec {
  encodeJpeg(
    source: Uint8Array,
    options: { maxBytes: number; maxDimension: number; quality: number },
  ): EncodedVisualImage {
    let image = nativeImage.createFromBuffer(Buffer.from(source));
    if (image.isEmpty()) throw new Error('visual frame cannot be decoded');
    const initial = image.getSize();
    if (initial.width < 1 || initial.height < 1) {
      throw new Error('visual frame dimensions are invalid');
    }
    const initialScale = Math.min(1, options.maxDimension / Math.max(initial.width, initial.height));
    if (initialScale < 1) {
      image = image.resize({
        height: Math.max(1, Math.round(initial.height * initialScale)),
        quality: 'good',
        width: Math.max(1, Math.round(initial.width * initialScale)),
      });
    }

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const size = image.getSize();
      for (const quality of QUALITIES.filter((value) => value <= options.quality)) {
        const bytes = image.toJPEG(quality);
        if (bytes.length > 0 && bytes.length <= options.maxBytes) {
          return { bytes, height: size.height, width: size.width };
        }
      }
      if (Math.max(size.width, size.height) <= MIN_DIMENSION) break;
      const smallestJpegBytes = image.toJPEG(40).length;
      const scale = Math.max(0.5, Math.min(
        0.85,
        Math.sqrt(options.maxBytes / Math.max(1, smallestJpegBytes)) * 0.9,
      ));
      const nextWidth = Math.max(1, Math.round(size.width * scale));
      const nextHeight = Math.max(1, Math.round(size.height * scale));
      if (nextWidth === size.width && nextHeight === size.height) break;
      image = image.resize({ height: nextHeight, quality: 'good', width: nextWidth });
    }
    throw new Error('visual frame cannot be compressed within the controlled limit');
  }
}
