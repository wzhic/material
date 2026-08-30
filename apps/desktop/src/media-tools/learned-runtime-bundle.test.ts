import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  LEARNED_RUNTIME_MANIFEST_NAME,
  LearnedRuntimeBundleError,
  parseLearnedRuntimeBundleManifest,
  resolveLearnedRuntimeBundle,
} from './learned-runtime-bundle';

const roots: string[] = [];
const fixturePlatform: NodeJS.Platform = process.platform === 'win32' ? 'win32' : 'darwin';

const sha256 = (value: Buffer): string =>
  createHash('sha256').update(value).digest('hex');

const makeBundle = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'material-learned-runtime-'));
  roots.push(root);
  const contents: Record<string, Buffer> = {
    'models/asr/model.bin': Buffer.from('asr-model'),
    'models/ocr/det/inference.json': Buffer.from('ocr-detector'),
    'models/ocr/rec/inference.json': Buffer.from('ocr-recognizer'),
    'models/yamnet/saved_model.pb': Buffer.from('yamnet-model'),
    'runtime/media_runtime.py': Buffer.from('print("ready")\n'),
    'runtime/python/bin/python3': Buffer.from('#!/bin/sh\nexit 0\n'),
  };
  for (const [relativePath, content] of Object.entries(contents)) {
    const absolutePath = path.join(root, ...relativePath.split('/'));
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
    if (relativePath === 'runtime/python/bin/python3') await chmod(absolutePath, 0o755);
  }
  const files = await Promise.all(Object.entries(contents).map(async ([filePath, content]) => ({
    bytes: content.byteLength,
    executable: filePath === 'runtime/python/bin/python3',
    path: filePath,
    sha256: sha256(content),
  })));
  const manifest = {
    bundleVersion: '2026.08.27.1',
    components: [
      {
        license: 'Apache-2.0',
        name: 'runtime-fixture',
        source: 'https://example.invalid/runtime-fixture',
        version: '1.0.0',
      },
    ],
    files,
    models: {
      asr: { id: 'asr-fixture', root: 'models/asr', version: '1' },
      audioEvent: { id: 'yamnet-fixture', root: 'models/yamnet', version: '1' },
      ocr: {
        detection: 'models/ocr/det',
        id: 'ocr-fixture',
        recognition: 'models/ocr/rec',
        root: 'models/ocr',
        version: '1',
      },
    },
    runtime: {
      python: 'runtime/python/bin/python3',
      pythonVersion: '3.11.11',
      script: 'runtime/media_runtime.py',
    },
    schemaVersion: 1,
    target: { arch: 'arm64', platform: fixturePlatform },
  };
  await writeFile(
    path.join(root, LEARNED_RUNTIME_MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('learned runtime bundle', () => {
  it('validates the complete file set and resolves only bundle-contained paths', async () => {
    const root = await makeBundle();

    const configuration = await resolveLearnedRuntimeBundle({
      arch: 'arm64',
      platform: fixturePlatform,
      root,
    });
    expect(configuration).toMatchObject({
      asrModelPath: path.join(root, 'models', 'asr'),
      audioEventModelPath: path.join(root, 'models', 'yamnet'),
      ocrLanguage: 'ch',
      ocrModelPath: path.join(root, 'models', 'ocr'),
      pythonPath: path.join(root, 'runtime', 'python', 'bin', 'python3'),
      scriptPath: path.join(root, 'runtime', 'media_runtime.py'),
    });
    expect(configuration.verifyIntegrity).toEqual(expect.any(Function));
  });

  it('fails closed when a declared file is changed or an undeclared file appears', async () => {
    const tampered = await makeBundle();
    await writeFile(path.join(tampered, 'models', 'asr', 'model.bin'), 'changed');
    await expect(resolveLearnedRuntimeBundle({
      arch: 'arm64', platform: fixturePlatform, root: tampered,
    })).rejects.toMatchObject({ reason: 'FILE_METADATA' });

    const withExtra = await makeBundle();
    await writeFile(path.join(withExtra, 'unexpected.txt'), 'extra');
    await expect(resolveLearnedRuntimeBundle({
      arch: 'arm64', platform: fixturePlatform, root: withExtra,
    })).rejects.toMatchObject({ reason: 'FILE_SET' });
  });

  it('rejects target mismatches and symbolic links without exposing local paths', async () => {
    const mismatched = await makeBundle();
    await expect(resolveLearnedRuntimeBundle({
      arch: 'x64', platform: fixturePlatform, root: mismatched,
    })).rejects.toMatchObject({ reason: 'TARGET_MISMATCH' });

    const linked = await makeBundle();
    // Windows hosted runners can create directory junctions without the
    // elevated file-symlink privilege. Both are links that the verifier must
    // reject before following their targets.
    const linkedPath = process.platform === 'win32'
      ? path.join(linked, 'models', 'linked-asr')
      : path.join(linked, 'models', 'asr', 'linked.bin');
    await symlink(
      process.platform === 'win32'
        ? path.join(linked, 'models', 'asr')
        : path.join(linked, 'models', 'asr', 'model.bin'),
      linkedPath,
      process.platform === 'win32' ? 'junction' : 'file',
    );
    expect((await lstat(linkedPath)).isSymbolicLink()).toBe(true);
    try {
      const error = await resolveLearnedRuntimeBundle({
        arch: 'arm64', platform: fixturePlatform, root: linked,
      }).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(LearnedRuntimeBundleError);
      expect(String(error)).not.toContain(linked);
    } finally {
      // Remove the link before recursive fixture cleanup. Windows can retain a
      // junction handle briefly after enumeration when the full suite is busy.
      await rm(linkedPath, {
        force: true,
        maxRetries: process.platform === 'win32' ? 5 : 0,
        recursive: process.platform === 'win32',
        retryDelay: 100,
      });
    }
  });

  it('rejects path traversal and unknown manifest fields', async () => {
    const root = await makeBundle();
    const manifestPath = path.join(root, LEARNED_RUNTIME_MANIFEST_NAME);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    expect(() => parseLearnedRuntimeBundleManifest({ ...manifest, extra: true }))
      .toThrow(/MANIFEST_SCHEMA/);
    const runtime = manifest.runtime as Record<string, unknown>;
    expect(() => parseLearnedRuntimeBundleManifest({
      ...manifest,
      runtime: { ...runtime, script: '../media_runtime.py' },
    })).toThrow(/SCRIPT_PATH/);
  });
});
