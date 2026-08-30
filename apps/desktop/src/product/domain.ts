import {
  GameContext,
  ProductDimension,
  ProductIndustry,
  ProductInput,
  ProductRecord,
} from './types';

const NAME_LIMIT = 256;
const DETAIL_KEY_LIMIT = 100;
const DETAIL_VALUE_LIMIT = 10_000;
const DETAIL_COUNT_LIMIT = 64;
const CHILD_COUNT_LIMIT = 100;
const CONTEXT_COUNT_LIMIT = 200;
const PRODUCT_JSON_LIMIT = 1_048_576;

export class ProductValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductValidationError';
  }
}

export const normalizeSearchText = (value: string): string =>
  value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('zh-CN');

const requireName = (value: string, label: string): string => {
  const normalized = value.normalize('NFC').trim();
  if (!normalized) {
    throw new ProductValidationError(`${label}不能为空`);
  }
  if (normalized.length > NAME_LIMIT) {
    throw new ProductValidationError(`${label}不能超过 ${NAME_LIMIT} 个字符`);
  }
  return normalized;
};

const normalizeDetails = (details: Record<string, string>): Record<string, string> => {
  const entries = Object.entries(details).filter(([, value]) => value.trim());
  if (entries.length > DETAIL_COUNT_LIMIT) {
    throw new ProductValidationError(`补充信息不能超过 ${DETAIL_COUNT_LIMIT} 项`);
  }

  return Object.fromEntries(
    entries.map(([key, value]) => {
      const normalizedKey = key.normalize('NFC').trim();
      const normalizedValue = value.normalize('NFC').trim();
      if (!normalizedKey || normalizedKey.length > DETAIL_KEY_LIMIT) {
        throw new ProductValidationError('补充信息字段名称无效');
      }
      if (normalizedValue.length > DETAIL_VALUE_LIMIT) {
        throw new ProductValidationError(
          `${normalizedKey}不能超过 ${DETAIL_VALUE_LIMIT} 个字符`,
        );
      }
      return [normalizedKey, normalizedValue];
    }),
  );
};

const normalizeDimensions = (
  items: ProductDimension[],
  label: string,
): ProductDimension[] => {
  if (items.length > CHILD_COUNT_LIMIT) {
    throw new ProductValidationError(`${label}不能超过 ${CHILD_COUNT_LIMIT} 项`);
  }
  const seen = new Set<string>();
  return items.map((item) => {
    const name = requireName(item.name, `${label}名称`);
    const normalizedName = normalizeSearchText(name);
    if (seen.has(normalizedName)) {
      throw new ProductValidationError(`${label}名称不能重复`);
    }
    seen.add(normalizedName);
    return {
      id: requireName(item.id, `${label}标识`),
      name,
      notes: item.notes.normalize('NFC').trim(),
    };
  });
};

const normalizeContexts = (
  contexts: GameContext[],
  versionIds: Set<string>,
  channelIds: Set<string>,
): GameContext[] => {
  if (contexts.length > CONTEXT_COUNT_LIMIT) {
    throw new ProductValidationError(`版本渠道差异不能超过 ${CONTEXT_COUNT_LIMIT} 项`);
  }
  return contexts.map((context) => {
    const id = requireName(context.id, '组合上下文标识');
    const notes = context.notes.normalize('NFC').trim();
    if (!context.versionId && !context.channelId) {
      throw new ProductValidationError('版本渠道差异至少要选择一个版本或渠道');
    }
    if (context.versionId && !versionIds.has(context.versionId)) {
      throw new ProductValidationError('版本渠道差异引用了不存在的版本');
    }
    if (context.channelId && !channelIds.has(context.channelId)) {
      throw new ProductValidationError('版本渠道差异引用了不存在的渠道');
    }
    if (!notes) {
      throw new ProductValidationError('版本渠道差异内容不能为空');
    }
    if (notes.length > DETAIL_VALUE_LIMIT) {
      throw new ProductValidationError('版本渠道差异内容过长');
    }
    return { ...context, id, notes };
  });
};

export const normalizeProductInput = (input: ProductInput): ProductInput => {
  if (input.industry !== 'apparel' && input.industry !== 'game') {
    throw new ProductValidationError('请选择产品行业');
  }

  const name = requireName(input.name, input.industry === 'game' ? '游戏名称' : '产品名称');
  const details = normalizeDetails(input.details);

  if (input.industry === 'apparel') {
    const apparelCategory = requireName(input.apparelCategory ?? '', '服饰类别');
    const normalized: ProductInput = {
      industry: 'apparel',
      name,
      apparelCategory,
      details,
      versions: [],
      channels: [],
      contexts: [],
    };
    if (JSON.stringify(normalized).length > PRODUCT_JSON_LIMIT) {
      throw new ProductValidationError('产品信息总量超过安全上限');
    }
    return normalized;
  }

  const versions = normalizeDimensions(input.versions, '版本');
  const channels = normalizeDimensions(input.channels, '渠道');
  const contexts = normalizeContexts(
    input.contexts,
    new Set(versions.map((item) => item.id)),
    new Set(channels.map((item) => item.id)),
  );
  const normalized: ProductInput = {
    industry: 'game',
    name,
    apparelCategory: null,
    details,
    versions,
    channels,
    contexts,
  };
  if (JSON.stringify(normalized).length > PRODUCT_JSON_LIMIT) {
    throw new ProductValidationError('产品信息总量超过安全上限');
  }
  return normalized;
};

export const buildProductSearchText = (input: ProductInput): string =>
  normalizeSearchText(
    [
      input.name,
      input.apparelCategory ?? '',
      ...Object.values(input.details),
      ...input.versions.flatMap((item) => [item.name, item.notes]),
      ...input.channels.flatMap((item) => [item.name, item.notes]),
      ...input.contexts.map((item) => item.notes),
    ].join(' '),
  );

export const productIndustryLabel = (industry: ProductIndustry): string =>
  industry === 'apparel' ? '服饰' : '游戏';

export const productSummary = (product: ProductRecord | ProductInput): string => {
  if (product.industry === 'apparel') {
    return product.apparelCategory ?? '未填写服饰类别';
  }
  const pieces = [
    product.details['游戏类型'],
    product.versions.length ? `${product.versions.length} 个版本` : '',
    product.channels.length ? `${product.channels.length} 个渠道` : '',
  ].filter(Boolean);
  return pieces.join(' · ') || '基础游戏信息';
};
