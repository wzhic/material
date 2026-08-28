#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MANIFEST_NAME = 'learned-runtime-manifest.json';

const fail = (reason) => {
  throw new Error(`learned runtime assembly failed: ${reason}`);
};

const object = (value, reason) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(reason);
  return value;
};

const text = (value, reason) => {
  if (typeof value !== 'string' || !value || value.length > 1000 || /[\0\r\n]/.test(value)) {
    fail(reason);
  }
  return value;
};

const sourcePath = (value, reason) => {
  const candidate = path.resolve(text(value, reason));
  if (!path.isAbsolute(candidate)) fail(reason);
  return candidate;
};

const relativePath = (value, reason) => {
  const candidate = text(value, reason);
  if (
    path.isAbsolute(candidate)
    || candidate.includes('\\')
    || candidate.split('/').some((part) => !part || part === '.' || part === '..')
    || path.posix.normalize(candidate) !== candidate
  ) fail(reason);
  return candidate;
};

const assertDirectory = async (directory, reason) => {
  const metadata = await lstat(directory).catch(() => null);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) fail(reason);
};

const copyTree = async (source, destination, boundary = source) => {
  await assertDirectory(source, 'SOURCE_DIRECTORY');
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      const link = await readlink(from);
      if (path.isAbsolute(link)) fail('SOURCE_SYMLINK');
      const resolved = path.resolve(path.dirname(from), link);
      const relativeToBoundary = path.relative(boundary, resolved);
      if (
        !relativeToBoundary
        || relativeToBoundary.startsWith('..')
        || path.isAbsolute(relativeToBoundary)
      ) fail('SOURCE_SYMLINK');
      const targetMetadata = await lstat(resolved).catch(() => null);
      if (!targetMetadata?.isFile() || targetMetadata.isSymbolicLink()) fail('SOURCE_SYMLINK');
      await copyFile(resolved, to);
    } else if (entry.isDirectory()) await copyTree(from, to, boundary);
    else if (entry.isFile()) await copyFile(from, to);
    else fail('SOURCE_FILE_TYPE');
  }
};

const hashFile = async (filePath) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
};

const listFiles = async (root, directory = root) => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) fail('OUTPUT_SYMLINK');
    if (entry.isDirectory()) files.push(...await listFiles(root, absolute));
    else if (entry.isFile()) files.push(absolute);
    else fail('OUTPUT_FILE_TYPE');
  }
  return files;
};

const parseArguments = (argv) => {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--output', '--spec'].includes(key) || !value) fail('USAGE');
    values[key.slice(2)] = value;
  }
  if (!values.output || !values.spec) fail('USAGE');
  return { output: path.resolve(values.output), spec: path.resolve(values.spec) };
};

export const assembleLearnedRuntime = async ({ output, spec: specPath }) => {
  const outputMetadata = await lstat(output).catch(() => null);
  if (outputMetadata) fail('OUTPUT_EXISTS');
  const raw = JSON.parse(await readFile(specPath, 'utf8'));
  const spec = object(raw, 'SPEC_SCHEMA');
  if (spec.schemaVersion !== 1) fail('SPEC_VERSION');
  const target = object(spec.target, 'TARGET_SCHEMA');
  const platform = text(target.platform, 'TARGET_PLATFORM');
  const arch = text(target.arch, 'TARGET_ARCH');
  if (!['darwin', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
    fail('TARGET_UNSUPPORTED');
  }
  const python = object(spec.python, 'PYTHON_SCHEMA');
  const pythonRoot = sourcePath(python.sourceRoot, 'PYTHON_SOURCE');
  const pythonExecutable = relativePath(python.executable, 'PYTHON_EXECUTABLE');
  if (!/^3\.11(?:\.\d+)?$/.test(text(python.version, 'PYTHON_VERSION'))) {
    fail('PYTHON_VERSION');
  }
  const models = object(spec.models, 'MODELS_SCHEMA');
  const ocr = object(models.ocr, 'OCR_MODEL_SCHEMA');
  const asr = object(models.asr, 'ASR_MODEL_SCHEMA');
  const audioEvent = object(models.audioEvent, 'AUDIO_EVENT_MODEL_SCHEMA');
  const components = spec.components;
  if (!Array.isArray(components) || components.length === 0) fail('COMPONENTS_SCHEMA');
  const normalizedComponents = components.map((value) => {
    const component = object(value, 'COMPONENT_SCHEMA');
    const source = text(component.source, 'COMPONENT_SOURCE');
    if (!source.startsWith('https://')) fail('COMPONENT_SOURCE');
    return {
      license: text(component.license, 'COMPONENT_LICENSE'),
      name: text(component.name, 'COMPONENT_NAME'),
      source,
      version: text(component.version, 'COMPONENT_VERSION'),
    };
  });
  const parent = path.dirname(output);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(path.join(parent, '.learned-runtime-staging-'));
  try {
    await copyTree(pythonRoot, path.join(staging, 'runtime', 'python'));
    const scriptSource = sourcePath(spec.scriptSource, 'SCRIPT_SOURCE');
    const scriptMetadata = await lstat(scriptSource).catch(() => null);
    if (!scriptMetadata?.isFile() || scriptMetadata.isSymbolicLink()) fail('SCRIPT_SOURCE');
    await mkdir(path.join(staging, 'runtime'), { recursive: true });
    await copyFile(scriptSource, path.join(staging, 'runtime', 'media_runtime.py'));
    await copyTree(sourcePath(ocr.sourceRoot, 'OCR_MODEL_SOURCE'), path.join(staging, 'models', 'ocr'));
    await copyTree(sourcePath(asr.sourceRoot, 'ASR_MODEL_SOURCE'), path.join(staging, 'models', 'asr'));
    await copyTree(
      sourcePath(audioEvent.sourceRoot, 'AUDIO_EVENT_MODEL_SOURCE'),
      path.join(staging, 'models', 'yamnet'),
    );
    const installedPython = path.join(staging, 'runtime', 'python', ...pythonExecutable.split('/'));
    const installedPythonMetadata = await lstat(installedPython).catch(() => null);
    if (!installedPythonMetadata?.isFile() || installedPythonMetadata.isSymbolicLink()) {
      fail('PYTHON_EXECUTABLE');
    }
    if (platform !== 'win32') await chmod(installedPython, installedPythonMetadata.mode | 0o500);
    const detection = relativePath(ocr.detection, 'OCR_DETECTION');
    const recognition = relativePath(ocr.recognition, 'OCR_RECOGNITION');
    await assertDirectory(path.join(staging, 'models', 'ocr', ...detection.split('/')), 'OCR_DETECTION');
    await assertDirectory(path.join(staging, 'models', 'ocr', ...recognition.split('/')), 'OCR_RECOGNITION');
    await writeFile(
      path.join(staging, 'THIRD_PARTY_NOTICES.json'),
      `${JSON.stringify({ components: normalizedComponents, schemaVersion: 1 }, null, 2)}\n`,
    );
    const files = [];
    for (const absolute of (await listFiles(staging)).sort()) {
      const metadata = await lstat(absolute);
      files.push({
        bytes: metadata.size,
        executable: platform !== 'win32' && (metadata.mode & 0o111) !== 0,
        path: path.relative(staging, absolute).split(path.sep).join('/'),
        sha256: await hashFile(absolute),
      });
    }
    const manifest = {
      bundleVersion: text(spec.bundleVersion, 'BUNDLE_VERSION'),
      components: normalizedComponents,
      files,
      models: {
        asr: {
          id: text(asr.id, 'ASR_MODEL_ID'),
          root: 'models/asr',
          version: text(asr.version, 'ASR_MODEL_VERSION'),
        },
        audioEvent: {
          id: text(audioEvent.id, 'AUDIO_EVENT_MODEL_ID'),
          root: 'models/yamnet',
          version: text(audioEvent.version, 'AUDIO_EVENT_MODEL_VERSION'),
        },
        ocr: {
          detection: `models/ocr/${detection}`,
          id: text(ocr.id, 'OCR_MODEL_ID'),
          recognition: `models/ocr/${recognition}`,
          root: 'models/ocr',
          version: text(ocr.version, 'OCR_MODEL_VERSION'),
        },
      },
      runtime: {
        python: `runtime/python/${pythonExecutable}`,
        pythonVersion: text(python.version, 'PYTHON_VERSION'),
        script: 'runtime/media_runtime.py',
      },
      schemaVersion: 1,
      target: { arch, platform },
    };
    await writeFile(path.join(staging, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(staging, output);
    return manifest;
  } catch (error) {
    await rm(staging, { force: true, recursive: true });
    throw error;
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assembleLearnedRuntime(parseArguments(process.argv.slice(2)))
    .then((manifest) => {
      process.stdout.write(`${JSON.stringify({
        bundleVersion: manifest.bundleVersion,
        files: manifest.files.length,
        target: manifest.target,
      })}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'learned runtime assembly failed'}\n`);
      process.exitCode = 1;
    });
}
