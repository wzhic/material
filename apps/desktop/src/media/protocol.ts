import { protocol } from 'electron';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

import { parseByteRange } from './range';
import { MaterialSessionService } from './session';
import { MATERIAL_PROTOCOL_SCHEME } from './types';

protocol.registerSchemesAsPrivileged([
  {
    scheme: MATERIAL_PROTOCOL_SCHEME,
    privileges: {
      bypassCSP: false,
      secure: true,
      standard: true,
      stream: true,
      supportFetchAPI: true,
    },
  },
]);

const failureResponse = (status: number, message: string): Response =>
  new Response(message, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    status,
  });

export const registerMaterialProtocol = (service: MaterialSessionService): void => {
  protocol.handle(MATERIAL_PROTOCOL_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return failureResponse(405, 'Method not allowed');
    }
    const url = new URL(request.url);
    if (url.hostname !== 'session') {
      return failureResponse(404, 'Media session not found');
    }
    const sessionId = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const source = await service.resolvePreviewSource(sessionId);
    if (!source) {
      return failureResponse(404, 'Media session is unavailable');
    }
    const range = parseByteRange(request.headers.get('range'), source.size);
    if (range === 'invalid') {
      return new Response(null, {
        headers: { 'content-range': `bytes */${source.size}` },
        status: 416,
      });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, source.size - 1);
    const headers: Record<string, string> = {
      'accept-ranges': 'bytes',
      'content-length': String(source.size ? end - start + 1 : 0),
      'content-type': source.mimeType,
    };
    if (range) {
      headers['content-range'] = `bytes ${start}-${end}/${source.size}`;
    }
    const body =
      request.method === 'HEAD' || source.size === 0
        ? null
        : (Readable.toWeb(
            createReadStream(source.filePath, { end, start }),
          ) as ReadableStream);
    return new Response(body, {
      headers,
      status: range ? 206 : 200,
    });
  });
};
