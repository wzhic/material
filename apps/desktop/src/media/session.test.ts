import {
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MaterialSessionError, MaterialSessionService } from './session';

describe('MaterialSessionService', () => {
  let directory: string;
  let service: MaterialSessionService;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'material-session-'));
    service = new MaterialSessionService();
  });

  afterEach(() => {
    service.clear();
    rmSync(directory, { force: true, recursive: true });
  });

  it('registers a safe opaque session without exposing an absolute path', async () => {
    const filePath = path.join(directory, 'lookbook.mp4');
    writeFileSync(filePath, 'same-video-content');

    const session = await service.register(filePath);

    expect(session.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.previewUrl).toBe(`material-local://session/${session.sessionId}`);
    expect(session.summary.name).toBe('lookbook.mp4');
    expect(session.summary.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(session)).not.toContain(directory);
    expect((await service.resolvePreviewSource(session.sessionId))?.filePath).toBe(
      realpathSync(filePath),
    );
    const toolSource = await service.resolveToolSource(session.sessionId);
    expect(toolSource.filePath).toBe(realpathSync(filePath));
    expect(toolSource.summary).toEqual(session.summary);
    expect(JSON.stringify(session)).not.toContain(toolSource.filePath);
  });

  it('reports a moved file and restores the same bytes at a new location', async () => {
    const originalPath = path.join(directory, 'original.png');
    const movedPath = path.join(directory, 'moved.png');
    writeFileSync(originalPath, 'stable-image-content');
    const session = await service.register(originalPath);
    renameSync(originalPath, movedPath);

    expect((await service.inspect(session.sessionId)).sourceStatus).toBe(
      'needs_relocation',
    );
    const relocated = await service.relocate(session.sessionId, movedPath);

    expect(relocated.mismatch).toBeNull();
    expect(relocated.session.sourceStatus).toBe('available');
    expect(relocated.session.summary.name).toBe('moved.png');
    expect((await service.resolvePreviewSource(session.sessionId))?.filePath).toBe(
      realpathSync(movedPath),
    );
  });

  it('rejects a different file without replacing the original session path', async () => {
    const originalPath = path.join(directory, 'creative.mp4');
    const candidatePath = path.join(directory, 'other.mp4');
    writeFileSync(originalPath, 'expected');
    writeFileSync(candidatePath, 'different');
    const session = await service.register(originalPath);

    const result = await service.relocate(session.sessionId, candidatePath);

    expect(result.session.sourceStatus).toBe('mismatch');
    expect(result.mismatch?.candidate.name).toBe('other.mp4');
    expect(JSON.stringify(result)).not.toContain(directory);
    expect(await service.resolvePreviewSource(session.sessionId)).toBeNull();
    expect((await service.inspect(session.sessionId)).sourceStatus).toBe('available');
    expect((await service.resolvePreviewSource(session.sessionId))?.filePath).toBe(
      realpathSync(originalPath),
    );
  });

  it('detects in-place content changes even when the media extension is unchanged', async () => {
    const filePath = path.join(directory, 'creative.webm');
    writeFileSync(filePath, 'first');
    const session = await service.register(filePath);
    writeFileSync(filePath, 'other');

    expect((await service.inspect(session.sessionId)).sourceStatus).toBe('mismatch');
  });

  it('releases draft handles and rejects unsupported files', async () => {
    const videoPath = path.join(directory, 'creative.mov');
    const textPath = path.join(directory, 'notes.txt');
    writeFileSync(videoPath, 'video');
    writeFileSync(textPath, 'text');
    const session = await service.register(videoPath);
    service.release(session.sessionId);

    await expect(service.inspect(session.sessionId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(service.register(textPath)).rejects.toBeInstanceOf(MaterialSessionError);
  });
});
