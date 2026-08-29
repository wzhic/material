import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { LocalLearnedRuntimeConfiguration } from './learned-runtime';

export const LEARNED_RUNTIME_MANIFEST_NAME = 'learned-runtime-manifest.json';

type SupportedPlatform = 'darwin' | 'win32';
type SupportedArchitecture = 'arm64' | 'x64';

interface BundleFile {
  bytes: number;
  executable: boolean;
  path: string;
  sha256: string;
}

interface BundleModel {
  id: string;
  root: string;
  version: string;
}

interface OcrBundleModel extends BundleModel {
  detection: string;
  recognition: string;
}

export interface LearnedRuntimeBundleManifest {
  bundleVersion: string;
  components: readonly {
    license: string;
    name: string;
    source: string;
    version: string;
  }[];
  files: readonly BundleFile[];
  models: {
    asr: BundleModel;
    audioEvent: BundleModel;
    ocr: OcrBundleModel;
  };
  runtime: {
    python: string;
    pythonVersion: string;
    script: string;
  };
  schemaVersion: 1;
  target: {
    arch: SupportedArchitecture;
    platform: SupportedPlatform;
  };
}

export class LearnedRuntimeBundleError extends Error {
  constructor(readonly reason: string) {
    super(`本地学习型媒体运行时包无效（${reason}）`);
    this.name = 'LearnedRuntimeBundleError';
  }
}

const object = (value: unknown, reason: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LearnedRuntimeBundleError(reason);
  }
  return value as Record<string, unknown>;
};

const exactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
  reason: string,
): void => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new LearnedRuntimeBundleError(reason);
  }
};

const boundedString = (
  value: unknown,
  reason: string,
  pattern = /^[^\0\r\n]{1,240}$/,
): string => {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new LearnedRuntimeBundleError(reason);
  }
  return value;
};

const relativePath = (value: unknown, reason: string): string => {
  const candidate = boundedString(value, reason, /^[^\0\\\r\n]{1,500}$/);
  if (
    candidate.startsWith('/')
    || candidate === '.'
    || candidate === '..'
    || candidate.split('/').some((part) => !part || part === '.' || part === '..')
    || path.posix.normalize(candidate) !== candidate
  ) {
    throw new LearnedRuntimeBundleError(reason);
  }
  return candidate;
};

const parseModel = (value: unknown, reason: string): BundleModel => {
  const model = object(value, reason);
  exactKeys(model, ['id', 'root', 'version'], reason);
  return {
    id: boundedString(model.id, reason),
    root: relativePath(model.root, reason),
    version: boundedString(model.version, reason),
  };
};

export const parseLearnedRuntimeBundleManifest = (
  value: unknown,
): LearnedRuntimeBundleManifest => {
  const manifest = object(value, 'MANIFEST_SCHEMA');
  exactKeys(
    manifest,
    ['bundleVersion', 'components', 'files', 'models', 'runtime', 'schemaVersion', 'target'],
    'MANIFEST_SCHEMA',
  );
  if (manifest.schemaVersion !== 1) {
    throw new LearnedRuntimeBundleError('MANIFEST_VERSION');
  }
  const target = object(manifest.target, 'TARGET_SCHEMA');
  exactKeys(target, ['arch', 'platform'], 'TARGET_SCHEMA');
  const platform = boundedString(target.platform, 'TARGET_PLATFORM');
  const arch = boundedString(target.arch, 'TARGET_ARCH');
  if (!['darwin', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
    throw new LearnedRuntimeBundleError('TARGET_UNSUPPORTED');
  }
  const runtime = object(manifest.runtime, 'RUNTIME_SCHEMA');
  exactKeys(runtime, ['python', 'pythonVersion', 'script'], 'RUNTIME_SCHEMA');
  const models = object(manifest.models, 'MODEL_SCHEMA');
  exactKeys(models, ['asr', 'audioEvent', 'ocr'], 'MODEL_SCHEMA');
  const ocrValue = object(models.ocr, 'OCR_MODEL_SCHEMA');
  exactKeys(
    ocrValue,
    ['detection', 'id', 'recognition', 'root', 'version'],
    'OCR_MODEL_SCHEMA',
  );
  const ocr: OcrBundleModel = {
    detection: relativePath(ocrValue.detection, 'OCR_MODEL_PATH'),
    id: boundedString(ocrValue.id, 'OCR_MODEL_ID'),
    recognition: relativePath(ocrValue.recognition, 'OCR_MODEL_PATH'),
    root: relativePath(ocrValue.root, 'OCR_MODEL_PATH'),
    version: boundedString(ocrValue.version, 'OCR_MODEL_VERSION'),
  };
  const componentsValue = manifest.components;
  if (!Array.isArray(componentsValue) || componentsValue.length === 0 || componentsValue.length > 256) {
    throw new LearnedRuntimeBundleError('COMPONENTS_SCHEMA');
  }
  const components = componentsValue.map((componentValue) => {
    const component = object(componentValue, 'COMPONENT_SCHEMA');
    exactKeys(component, ['license', 'name', 'source', 'version'], 'COMPONENT_SCHEMA');
    return {
      license: boundedString(component.license, 'COMPONENT_LICENSE'),
      name: boundedString(component.name, 'COMPONENT_NAME'),
      source: boundedString(component.source, 'COMPONENT_SOURCE', /^https:\/\/[^\0\r\n]{1,480}$/),
      version: boundedString(component.version, 'COMPONENT_VERSION'),
    };
  });
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new LearnedRuntimeBundleError('FILES_SCHEMA');
  }
  const seen = new Set<string>();
  const files = manifest.files.map((fileValue) => {
    const file = object(fileValue, 'FILE_SCHEMA');
    exactKeys(file, ['bytes', 'executable', 'path', 'sha256'], 'FILE_SCHEMA');
    const filePath = relativePath(file.path, 'FILE_PATH');
    if (seen.has(filePath)) throw new LearnedRuntimeBundleError('FILE_DUPLICATE');
    seen.add(filePath);
    if (!Number.isSafeInteger(file.bytes) || Number(file.bytes) < 0 || typeof file.executable !== 'boolean') {
      throw new LearnedRuntimeBundleError('FILE_METADATA');
    }
    return {
      bytes: Number(file.bytes),
      executable: file.executable,
      path: filePath,
      sha256: boundedString(file.sha256, 'FILE_HASH', /^[a-f0-9]{64}$/),
    };
  });
  const parsed = {
    bundleVersion: boundedString(manifest.bundleVersion, 'BUNDLE_VERSION'),
    components,
    files,
    models: {
      asr: parseModel(models.asr, 'ASR_MODEL_SCHEMA'),
      audioEvent: parseModel(models.audioEvent, 'AUDIO_EVENT_MODEL_SCHEMA'),
      ocr,
    },
    runtime: {
      python: relativePath(runtime.python, 'PYTHON_PATH'),
      pythonVersion: boundedString(runtime.pythonVersion, 'PYTHON_VERSION', /^3\.11(?:\.\d+)?$/),
      script: relativePath(runtime.script, 'SCRIPT_PATH'),
    },
    schemaVersion: 1 as const,
    target: {
      arch: arch as SupportedArchitecture,
      platform: platform as SupportedPlatform,
    },
  };
  const requiredFiles = [
    parsed.runtime.python,
    parsed.runtime.script,
  ];
  if (requiredFiles.some((filePath) => !seen.has(filePath))) {
    throw new LearnedRuntimeBundleError('REQUIRED_FILE_UNDECLARED');
  }
  for (const model of Object.values(parsed.models)) {
    if (!files.some((file) => file.path.startsWith(`${model.root}/`))) {
      throw new LearnedRuntimeBundleError('MODEL_EMPTY');
    }
  }
  if (
    !parsed.models.ocr.detection.startsWith(`${parsed.models.ocr.root}/`)
    || !parsed.models.ocr.recognition.startsWith(`${parsed.models.ocr.root}/`)
  ) {
    throw new LearnedRuntimeBundleError('OCR_MODEL_BOUNDARY');
  }
  return parsed;
};

const sha256File = async (filePath: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
};

const containedPath = (root: string, relative: string): string => {
  const candidate = path.resolve(root, ...relative.split('/'));
  const fromRoot = path.relative(root, candidate);
  if (!fromRoot || fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) {
    throw new LearnedRuntimeBundleError('PATH_BOUNDARY');
  }
  return candidate;
};

const listBundleFiles = async (root: string, directory = root): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new LearnedRuntimeBundleError('SYMLINK');
    if (entry.isDirectory()) files.push(...await listBundleFiles(root, entryPath));
    else if (entry.isFile()) files.push(path.relative(root, entryPath).split(path.sep).join('/'));
    else throw new LearnedRuntimeBundleError('FILE_TYPE');
  }
  return files;
};

export interface ResolveLearnedRuntimeBundleOptions {
  arch: NodeJS.Architecture;
  platform: NodeJS.Platform;
  root: string;
}

export const resolveLearnedRuntimeBundle = async (
  options: ResolveLearnedRuntimeBundleOptions,
): Promise<LocalLearnedRuntimeConfiguration> => {
  if (!path.isAbsolute(options.root)) throw new LearnedRuntimeBundleError('ROOT_PATH');
  let rootMetadata;
  try {
    rootMetadata = await lstat(options.root);
  } catch {
    throw new LearnedRuntimeBundleError('ROOT_MISSING');
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new LearnedRuntimeBundleError('ROOT_TYPE');
  }
  let rawManifest: unknown;
  try {
    const manifestBytes = await readFile(path.join(options.root, LEARNED_RUNTIME_MANIFEST_NAME));
    if (manifestBytes.byteLength > 16 * 1024 * 1024) {
      throw new LearnedRuntimeBundleError('MANIFEST_SIZE');
    }
    rawManifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (error) {
    if (error instanceof LearnedRuntimeBundleError) throw error;
    throw new LearnedRuntimeBundleError('MANIFEST_READ');
  }
  const manifest = parseLearnedRuntimeBundleManifest(rawManifest);
  if (manifest.target.platform !== options.platform || manifest.target.arch !== options.arch) {
    throw new LearnedRuntimeBundleError('TARGET_MISMATCH');
  }
  const expected = [...manifest.files.map((file) => file.path)].sort();
  const actual = (await listBundleFiles(options.root))
    .filter((file) => file !== LEARNED_RUNTIME_MANIFEST_NAME)
    .sort();
  if (actual.length !== expected.length || actual.some((file, index) => file !== expected[index])) {
    throw new LearnedRuntimeBundleError('FILE_SET');
  }
  for (const file of manifest.files) {
    const absolutePath = containedPath(options.root, file.path);
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== file.bytes) {
      throw new LearnedRuntimeBundleError('FILE_METADATA');
    }
    if (file.executable && options.platform !== 'win32' && (metadata.mode & 0o111) === 0) {
      throw new LearnedRuntimeBundleError('FILE_EXECUTABLE');
    }
    if (await sha256File(absolutePath) !== file.sha256) {
      throw new LearnedRuntimeBundleError('FILE_INTEGRITY');
    }
  }
  return {
    asrModelPath: containedPath(options.root, manifest.models.asr.root),
    audioEventModelPath: containedPath(options.root, manifest.models.audioEvent.root),
    ocrLanguage: 'ch',
    ocrModelPath: containedPath(options.root, manifest.models.ocr.root),
    pythonPath: containedPath(options.root, manifest.runtime.python),
    scriptPath: containedPath(options.root, manifest.runtime.script),
    verifyIntegrity: async () => {
      await resolveLearnedRuntimeBundle(options);
    },
  };
};
