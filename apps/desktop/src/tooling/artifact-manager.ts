import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { ToolArtifact, ToolResourceLimits, ToolWorkspace } from './types';

const DIRECTORY_PREFIX = 'material-tool-run-';
const SAFE_INVOCATION_ID = /^[0-9a-f-]{36}$/i;
const SAFE_MEDIA_TYPE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i;

export class ArtifactLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactLimitError';
  }
}

const within = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

const sha256File = (filePath: string): Promise<string> => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  stream.on('data', (chunk) => hash.update(chunk));
  stream.on('error', reject);
  stream.on('end', () => resolve(hash.digest('hex')));
});

class ManagedWorkspace implements ToolWorkspace {
  private readonly artifacts = new Map<string, ToolArtifact>();
  private totalBytes = 0;

  constructor(
    readonly directory: string,
    readonly invocationId: string,
    private readonly limits: ToolResourceLimits,
  ) {}

  async writeArtifact(
    relativePath: string,
    data: Uint8Array | string,
    mediaType: string,
  ): Promise<ToolArtifact> {
    const destination = this.resolve(relativePath);
    await this.ensureSafeParent(relativePath);
    await writeFile(destination, data, { flag: 'wx', mode: 0o600 });
    try {
      return await this.adoptArtifact(relativePath, mediaType);
    } catch (error) {
      await rm(destination, { force: true });
      throw error;
    }
  }

  async adoptArtifact(relativePath: string, mediaType: string): Promise<ToolArtifact> {
    if (!SAFE_MEDIA_TYPE.test(mediaType)) throw new Error('artifact media type is invalid');
    if (this.artifacts.has(relativePath)) throw new Error('artifact is already registered');
    if (this.artifacts.size >= this.limits.maxArtifacts) {
      throw new ArtifactLimitError('artifact count exceeds the configured limit');
    }
    const absolutePath = this.resolve(relativePath);
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error('artifact must be a regular non-symlink file');
    }
    const [realWorkspace, realArtifact] = await Promise.all([
      realpath(this.directory),
      realpath(absolutePath),
    ]);
    if (!within(realWorkspace, realArtifact)) {
      throw new Error('artifact resolves outside the managed workspace');
    }
    if (
      metadata.size > this.limits.maxArtifactBytes ||
      this.totalBytes + metadata.size > this.limits.maxArtifactBytes
    ) {
      throw new ArtifactLimitError('artifact bytes exceed the configured limit');
    }
    const artifact = Object.freeze({
      artifactId: randomUUID(),
      byteLength: metadata.size,
      mediaType,
      relativePath,
      sha256: await sha256File(realArtifact),
    });
    this.artifacts.set(relativePath, artifact);
    this.totalBytes += metadata.size;
    return artifact;
  }

  listArtifacts(): readonly ToolArtifact[] {
    return [...this.artifacts.values()];
  }

  async readArtifact(artifactId: string): Promise<Buffer> {
    const artifact = [...this.artifacts.values()].find(
      (candidate) => candidate.artifactId === artifactId,
    );
    if (!artifact) throw new Error('artifact does not exist in this workspace');
    const bytes = await readFile(this.resolve(artifact.relativePath));
    if (bytes.length !== artifact.byteLength || sha256(bytes) !== artifact.sha256) {
      throw new Error('artifact changed before it was consumed');
    }
    return bytes;
  }

  private resolve(relativePath: string): string {
    if (
      !relativePath ||
      relativePath.includes('\0') ||
      path.isAbsolute(relativePath) ||
      relativePath.split(/[\\/]/u).some((segment) => !segment || segment === '.' || segment === '..')
    ) {
      throw new Error('artifact path must be a safe relative path');
    }
    const destination = path.resolve(this.directory, relativePath);
    if (!within(this.directory, destination)) throw new Error('artifact path escapes workspace');
    return destination;
  }

  private async ensureSafeParent(relativePath: string): Promise<void> {
    const segments = relativePath.split(/[\\/]/u).slice(0, -1);
    let current = this.directory;
    for (const segment of segments) {
      current = path.join(current, segment);
      const metadata = await lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!metadata) {
        await mkdir(current, { mode: 0o700 });
        continue;
      }
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error('artifact parent must be a managed directory');
      }
    }
  }
}

export class TemporaryArtifactManager {
  constructor(private readonly rootDirectory: string) {}

  async createWorkspace(
    invocationId: string,
    limits: ToolResourceLimits,
  ): Promise<ToolWorkspace> {
    if (!SAFE_INVOCATION_ID.test(invocationId)) throw new Error('invocationId is invalid');
    await mkdir(this.rootDirectory, { mode: 0o700, recursive: true });
    const directory = this.workspacePath(invocationId);
    await mkdir(directory, { mode: 0o700 });
    return new ManagedWorkspace(directory, invocationId, limits);
  }

  async cleanup(invocationId: string): Promise<void> {
    const directory = this.workspacePath(invocationId);
    const metadata = await lstat(directory).catch(() => null);
    if (!metadata) return;
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('workspace cleanup target is not a managed directory');
    }
    await rm(directory, { recursive: true });
  }

  async readArtifact(
    invocationId: string,
    relativePath: string,
    expectedByteLength: number,
    expectedSha256: string,
  ): Promise<Buffer> {
    const directory = this.workspacePath(invocationId);
    if (
      !relativePath
      || relativePath.includes('\0')
      || path.isAbsolute(relativePath)
      || relativePath.split(/[\\/]/u).some(
        (segment) => !segment || segment === '.' || segment === '..',
      )
      || !Number.isSafeInteger(expectedByteLength)
      || expectedByteLength < 1
      || !/^[0-9a-f]{64}$/.test(expectedSha256)
    ) {
      throw new Error('artifact read contract is invalid');
    }
    const destination = path.resolve(directory, relativePath);
    if (!within(directory, destination)) throw new Error('artifact path escapes workspace');
    const [workspaceMetadata, artifactMetadata] = await Promise.all([
      lstat(directory),
      lstat(destination),
    ]);
    if (
      !workspaceMetadata.isDirectory()
      || workspaceMetadata.isSymbolicLink()
      || !artifactMetadata.isFile()
      || artifactMetadata.isSymbolicLink()
      || artifactMetadata.size !== expectedByteLength
    ) {
      throw new Error('artifact changed before it was consumed');
    }
    const [realWorkspace, realArtifact] = await Promise.all([
      realpath(directory),
      realpath(destination),
    ]);
    if (!within(realWorkspace, realArtifact)) {
      throw new Error('artifact resolves outside the managed workspace');
    }
    const bytes = await readFile(realArtifact);
    if (bytes.length !== expectedByteLength || sha256(bytes) !== expectedSha256) {
      throw new Error('artifact changed while it was consumed');
    }
    return bytes;
  }

  async sweepStale(olderThanMs: number, now = Date.now()): Promise<number> {
    if (!Number.isFinite(olderThanMs) || olderThanMs < 0) {
      throw new Error('stale age must be non-negative');
    }
    const entries = await readdir(this.rootDirectory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      },
    );
    let removed = 0;
    for (const entry of entries) {
      const invocationId = entry.name.slice(DIRECTORY_PREFIX.length);
      if (!entry.isDirectory() || !entry.name.startsWith(DIRECTORY_PREFIX)) continue;
      if (!SAFE_INVOCATION_ID.test(invocationId)) continue;
      const directory = this.workspacePath(invocationId);
      const metadata = await stat(directory);
      if (now - metadata.mtimeMs < olderThanMs) continue;
      await this.cleanup(invocationId);
      removed += 1;
    }
    return removed;
  }

  private workspacePath(invocationId: string): string {
    if (!SAFE_INVOCATION_ID.test(invocationId)) throw new Error('invocationId is invalid');
    const directory = path.resolve(this.rootDirectory, `${DIRECTORY_PREFIX}${invocationId}`);
    if (!within(path.resolve(this.rootDirectory), directory)) {
      throw new Error('workspace path escapes temporary root');
    }
    return directory;
  }
}
