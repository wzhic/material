export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  | JsonPrimitive
  | { [key: string]: JsonValue }
  | JsonValue[];

interface SchemaBase {
  description?: string;
}

export interface StringSchema extends SchemaBase {
  type: 'string';
  enum?: readonly string[];
  maxLength?: number;
  minLength?: number;
  pattern?: string;
}

export interface NumberSchema extends SchemaBase {
  type: 'number';
  integer?: boolean;
  maximum?: number;
  minimum?: number;
}

export interface BooleanSchema extends SchemaBase {
  type: 'boolean';
}

export interface NullSchema extends SchemaBase {
  type: 'null';
}

export interface ArraySchema extends SchemaBase {
  type: 'array';
  items: ValueSchema;
  maxItems?: number;
  minItems?: number;
}

export interface ObjectSchema extends SchemaBase {
  type: 'object';
  additionalProperties?: false;
  properties: Readonly<Record<string, ValueSchema>>;
  required?: readonly string[];
}

export interface UnionSchema extends SchemaBase {
  anyOf: readonly ValueSchema[];
}

export type ValueSchema =
  | ArraySchema
  | BooleanSchema
  | NullSchema
  | NumberSchema
  | ObjectSchema
  | StringSchema
  | UnionSchema;

export type ToolKind = 'builtin' | 'script' | 'skill';
export type ToolPermission =
  | 'material:read'
  | 'network:access'
  | 'process:spawn'
  | 'temp:write';
export type ToolFailureMode = 'optional' | 'required';

export interface ToolResourceLimits {
  maxArtifactBytes: number;
  maxArtifacts: number;
  maxOutputBytes: number;
  timeoutMs: number;
}

export interface ToolManifest {
  capabilityId: string;
  cancellable: boolean;
  displayName: string;
  failureMode: ToolFailureMode;
  inputSchema: ValueSchema;
  kind: ToolKind;
  outputSchema: ValueSchema;
  permissions: readonly ToolPermission[];
  resources: ToolResourceLimits;
  schemaVersion: 1;
  version: string;
}

export interface CapabilitySnapshot {
  capabilityId: string;
  cancellable: boolean;
  failureMode: ToolFailureMode;
  kind: ToolKind;
  manifestHash: string;
  permissions: readonly ToolPermission[];
  resources: ToolResourceLimits;
  schemaVersion: 1;
  version: string;
}

export interface ToolArtifact {
  artifactId: string;
  byteLength: number;
  mediaType: string;
  relativePath: string;
}

export interface ToolWorkspace {
  readonly directory: string;
  readonly invocationId: string;
  adoptArtifact(relativePath: string, mediaType: string): Promise<ToolArtifact>;
  listArtifacts(): readonly ToolArtifact[];
  writeArtifact(
    relativePath: string,
    data: Uint8Array | string,
    mediaType: string,
  ): Promise<ToolArtifact>;
}

export interface ToolAdapterContext {
  input: JsonValue;
  invocationId: string;
  limits: ToolResourceLimits;
  signal: AbortSignal;
  workspace: ToolWorkspace;
}

export interface ToolAdapter {
  readonly kind: ToolKind;
  execute(context: ToolAdapterContext): Promise<JsonValue>;
}

export type ToolErrorCode =
  | 'ARTIFACT_LIMIT'
  | 'CANCELLED'
  | 'CAPABILITY_NOT_FOUND'
  | 'EXECUTION_FAILED'
  | 'INTERNAL_ERROR'
  | 'INVALID_INPUT'
  | 'INVALID_OUTPUT'
  | 'OUTPUT_LIMIT'
  | 'POLICY_DENIED'
  | 'RESOURCE_BUSY'
  | 'TIMEOUT';

export interface ToolInvocationAudit {
  capability: CapabilitySnapshot | null;
  durationMs: number;
  errorCode: ToolErrorCode | null;
  finishedAt: string;
  inputBytes: number;
  invocationId: string;
  outputBytes: number;
  startedAt: string;
  status: 'cancelled' | 'failed' | 'succeeded' | 'timed_out';
}

export interface ToolInvocationSuccess {
  artifacts: readonly ToolArtifact[];
  audit: ToolInvocationAudit;
  capability: CapabilitySnapshot;
  invocationId: string;
  ok: true;
  output: JsonValue;
}

export interface ToolInvocationFailure {
  artifacts: readonly [];
  audit: ToolInvocationAudit;
  classification: ToolFailureMode;
  error: {
    code: ToolErrorCode;
    message: string;
  };
  invocationId: string;
  ok: false;
}

export type ToolInvocationResult =
  | ToolInvocationFailure
  | ToolInvocationSuccess;
