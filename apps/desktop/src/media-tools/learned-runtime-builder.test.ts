import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveLearnedRuntimeBundle } from './learned-runtime-bundle';

const executeFile = promisify(execFile);
const roots: string[] = [];

const writeFixture = async (root: string, relative: string, value: string): Promise<void> => {
  const absolute = path.join(root, ...relative.split('/'));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, value);
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('learned runtime assembler', () => {
  it('assembles a self-describing bundle accepted by the production verifier', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'material-runtime-builder-'));
    roots.push(root);
    const pythonRoot = path.join(root, 'python-source');
    const ocrRoot = path.join(root, 'ocr-source');
    const asrRoot = path.join(root, 'asr-source');
    const yamnetRoot = path.join(root, 'yamnet-source');
    await writeFixture(pythonRoot, 'bin/python3.11', '#!/bin/sh\nexit 0\n');
    await symlink('python3.11', path.join(pythonRoot, 'bin', 'python'));
    await writeFixture(ocrRoot, 'det/inference.json', '{}');
    await writeFixture(ocrRoot, 'rec/inference.json', '{}');
    await writeFixture(asrRoot, 'config.json', '{}');
    await writeFixture(asrRoot, 'model.bin', 'model');
    await writeFixture(yamnetRoot, 'saved_model.pb', 'model');
    await writeFixture(yamnetRoot, 'variables/variables.index', 'index');
    const scriptSource = path.join(root, 'media_runtime.py');
    await writeFile(scriptSource, 'print("ready")\n');
    const output = path.join(root, 'learned-runtime');
    const specPath = path.join(root, 'build-spec.json');
    await writeFile(specPath, JSON.stringify({
      bundleVersion: '2026.08.27.1',
      components: [{
        license: 'Apache-2.0',
        name: 'fixture',
        source: 'https://example.invalid/fixture',
        version: '1',
      }],
      models: {
        asr: { id: 'asr', sourceRoot: asrRoot, version: '1' },
        audioEvent: { id: 'yamnet', sourceRoot: yamnetRoot, version: '1' },
        ocr: {
          detection: 'det',
          id: 'ocr',
          recognition: 'rec',
          sourceRoot: ocrRoot,
          version: '1',
        },
      },
      python: { executable: 'bin/python', sourceRoot: pythonRoot, version: '3.11.11' },
      schemaVersion: 1,
      scriptSource,
      target: { arch: 'arm64', platform: 'darwin' },
    }));

    await executeFile(process.execPath, [
      path.resolve('scripts', 'assemble-learned-runtime.mjs'),
      '--spec', specPath,
      '--output', output,
    ]);

    await expect(resolveLearnedRuntimeBundle({
      arch: 'arm64', platform: 'darwin', root: output,
    })).resolves.toMatchObject({
      asrModelPath: path.join(output, 'models', 'asr'),
      scriptPath: path.join(output, 'runtime', 'media_runtime.py'),
    });
    await expect(executeFile(process.execPath, [
      path.resolve('scripts', 'assemble-learned-runtime.mjs'),
      '--spec', specPath,
      '--output', output,
    ])).rejects.toMatchObject({ stderr: expect.stringContaining('OUTPUT_EXISTS') });
  });
});
