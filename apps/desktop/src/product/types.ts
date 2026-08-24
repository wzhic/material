export type ProductIndustry = 'apparel' | 'game';

export interface ProductDimension {
  id: string;
  name: string;
  notes: string;
}

export interface GameContext {
  id: string;
  versionId: string | null;
  channelId: string | null;
  notes: string;
}

export interface ProductInput {
  industry: ProductIndustry;
  name: string;
  apparelCategory: string | null;
  details: Record<string, string>;
  versions: ProductDimension[];
  channels: ProductDimension[];
  contexts: GameContext[];
}

export interface ProductRecord extends ProductInput {
  id: string;
  writeVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProductListItem {
  id: string;
  industry: ProductIndustry;
  name: string;
  apparelCategory: string | null;
  summary: string;
  versionCount: number;
  channelCount: number;
  writeVersion: number;
  updatedAt: string;
}

export interface ProductListQuery {
  query?: string;
  industry?: ProductIndustry | '';
}

export interface DuplicateCandidate {
  id: string;
  name: string;
  industry: ProductIndustry;
  reason: string;
  updatedAt: string;
}

export interface ProductContextSelection {
  versionId?: string | null;
  channelId?: string | null;
  contextId?: string | null;
}

export interface ProductSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  sourceStatus: 'active';
  productId: string;
  productWriteVersion: number;
  industry: ProductIndustry;
  name: string;
  apparelCategory: string | null;
  details: Record<string, string>;
  game: {
    versions: ProductDimension[];
    channels: ProductDimension[];
    contexts: GameContext[];
    selection: ProductContextSelection;
  } | null;
}

export type ProductApiErrorCode =
  | 'CONFLICT'
  | 'DATABASE_UNAVAILABLE'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'UNKNOWN';

export interface ProductApiError {
  code: ProductApiErrorCode;
  message: string;
}

export type ProductApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ProductApiError };

export interface ProductApi {
  list: (query?: ProductListQuery) => Promise<ProductApiResult<ProductListItem[]>>;
  get: (id: string) => Promise<ProductApiResult<ProductRecord>>;
  findDuplicates: (
    input: ProductInput,
    excludeId?: string,
  ) => Promise<ProductApiResult<DuplicateCandidate[]>>;
  create: (input: ProductInput) => Promise<ProductApiResult<ProductRecord>>;
  update: (
    id: string,
    expectedVersion: number,
    input: ProductInput,
  ) => Promise<ProductApiResult<ProductRecord>>;
  remove: (id: string, expectedVersion: number) => Promise<ProductApiResult<null>>;
  snapshot: (
    id: string,
    selection?: ProductContextSelection,
  ) => Promise<ProductApiResult<ProductSnapshot>>;
}

export const PRODUCT_IPC_CHANNELS = {
  create: 'material:products:create',
  findDuplicates: 'material:products:find-duplicates',
  get: 'material:products:get',
  list: 'material:products:list',
  remove: 'material:products:remove',
  snapshot: 'material:products:snapshot',
  update: 'material:products:update',
} as const;
