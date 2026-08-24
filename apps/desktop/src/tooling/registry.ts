import { createHash } from 'node:crypto';

import { validateSchemaDefinition } from './schema';
import {
  CapabilitySnapshot,
  ToolAdapter,
  ToolManifest,
  ToolPermission,
  ToolResourceLimits,
} from './types';

export interface RegisteredTool {
  readonly adapter: ToolAdapter;
  readonly manifest: ToolManifest;
  readonly snapshot: CapabilitySnapshot;
}

const CAPABILITY_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PERMISSIONS = new Set<ToolPermission>([
  'material:read',
  'network:access',
  'process:spawn',
  'temp:write',
]);

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
};

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
};

const manifestHash = (manifest: ToolManifest): string =>
  `sha256:${createHash('sha256')
    .update(JSON.stringify(stableValue(manifest)))
    .digest('hex')}`;

const positiveInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value > 0;

const validateResources = (resources: ToolResourceLimits): void => {
  for (const [name, value] of Object.entries(resources)) {
    if (!positiveInteger(value)) {
      throw new Error(`resource limit ${name} must be a positive safe integer`);
    }
  }
};

const validateManifest = (manifest: ToolManifest, adapter: ToolAdapter): void => {
  if (!CAPABILITY_PATTERN.test(manifest.capabilityId)) {
    throw new Error('capabilityId is invalid');
  }
  if (!VERSION_PATTERN.test(manifest.version)) {
    throw new Error('version must be semantic version shaped');
  }
  if (!manifest.displayName.trim() || manifest.displayName.length > 120) {
    throw new Error('displayName is invalid');
  }
  if (manifest.kind !== adapter.kind) {
    throw new Error('adapter kind does not match manifest kind');
  }
  if (new Set(manifest.permissions).size !== manifest.permissions.length) {
    throw new Error('manifest contains duplicate permissions');
  }
  for (const permission of manifest.permissions) {
    if (!PERMISSIONS.has(permission)) throw new Error('manifest contains unknown permission');
  }
  validateResources(manifest.resources);
  if (!validateSchemaDefinition(manifest.inputSchema).ok) {
    throw new Error('input schema is invalid');
  }
  if (!validateSchemaDefinition(manifest.outputSchema).ok) {
    throw new Error('output schema is invalid');
  }
};

const freezeSnapshot = (snapshot: CapabilitySnapshot): CapabilitySnapshot => {
  Object.freeze(snapshot.permissions);
  Object.freeze(snapshot.resources);
  return Object.freeze(snapshot);
};

const versionParts = (version: string): readonly number[] =>
  version.split('-', 1)[0].split('.').map((part) => Number(part));

const compareVersions = (left: string, right: string): number => {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference;
  }
  return left.localeCompare(right);
};

export class ToolRegistry {
  private readonly registrations = new Map<string, RegisteredTool>();

  register(manifest: ToolManifest, adapter: ToolAdapter): CapabilitySnapshot {
    validateManifest(manifest, adapter);
    const key = this.key(manifest.capabilityId, manifest.version);
    if (this.registrations.has(key)) {
      throw new Error(`capability version is already registered: ${key}`);
    }
    const snapshot = freezeSnapshot({
      capabilityId: manifest.capabilityId,
      cancellable: manifest.cancellable,
      failureMode: manifest.failureMode,
      kind: manifest.kind,
      manifestHash: manifestHash(manifest),
      permissions: [...manifest.permissions],
      resources: { ...manifest.resources },
      schemaVersion: 1,
      version: manifest.version,
    });
    const storedManifest = deepFreeze(structuredClone(manifest));
    this.registrations.set(
      key,
      Object.freeze({ adapter, manifest: storedManifest, snapshot }),
    );
    return snapshot;
  }

  resolve(capabilityId: string, version?: string): RegisteredTool | null {
    if (version) return this.registrations.get(this.key(capabilityId, version)) ?? null;
    const candidates = [...this.registrations.values()].filter(
      (registration) => registration.manifest.capabilityId === capabilityId,
    );
    candidates.sort((left, right) =>
      compareVersions(right.manifest.version, left.manifest.version),
    );
    return candidates[0] ?? null;
  }

  snapshots(): readonly CapabilitySnapshot[] {
    return [...this.registrations.values()]
      .map((registration) => registration.snapshot)
      .sort((left, right) =>
        `${left.capabilityId}@${left.version}`.localeCompare(
          `${right.capabilityId}@${right.version}`,
        ),
      );
  }

  private key(capabilityId: string, version: string): string {
    return `${capabilityId}@${version}`;
  }
}
