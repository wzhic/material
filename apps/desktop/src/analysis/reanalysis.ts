import type { MaterialSession } from '../media/types';
import type { ProductListItem } from '../product/types';
import type { AnalysisRecord } from '../record/types';
import { CODEX_SUBSCRIPTION_CONFIGURATION_ID } from '../codex-subscription/types';

export interface ReanalysisModelOption {
  configurationDisplayName: string;
  configurationId: string;
  modelId: string;
  providerId: string;
  source: 'api-key' | 'codex-subscription';
  value: string;
}

export interface ReanalysisDraftSelection {
  conversionContext: string;
  industry: AnalysisRecord['industry'];
  modelSelectionValue: string;
  productId: string;
  sourceRecordId: string;
  warnings: string[];
}

export const matchesRecordedMaterial = (
  record: AnalysisRecord,
  material: MaterialSession,
): boolean => Boolean(
  record.material.fingerprintSha256
  && material.summary.fingerprintSha256 === record.material.fingerprintSha256,
);

export const prepareReanalysisDraft = (
  record: AnalysisRecord,
  models: ReanalysisModelOption[],
  products: ProductListItem[],
): ReanalysisDraftSelection => {
  const warnings: string[] = [];
  const hasRecordedSource = Boolean(
    record.run.modelConfigurationId
    && record.run.providerId,
  );
  const recordedSource = record.run.providerId === CODEX_SUBSCRIPTION_CONFIGURATION_ID
    ? 'codex-subscription'
    : 'api-key';
  const model = hasRecordedSource
    ? models.find((item) =>
      item.configurationId === record.run.modelConfigurationId
      && item.providerId === record.run.providerId
      && item.source === recordedSource
      && item.modelId === record.run.modelId)
    : null;
  if (!model) {
    warnings.push(hasRecordedSource
      ? '原模型配置或来源已删除或不可用，请显式选择模型后再启动。'
      : '历史记录缺少模型来源标识，无法安全恢复模型，请显式选择。');
  }
  const product = record.productSnapshot
    ? products.find((item) =>
      item.id === record.productSnapshot?.productId
      && item.industry === record.industry)
    : null;
  if (record.productSnapshot && !product) {
    warnings.push('原产品已删除或不可用，本次草稿默认不绑定产品。');
  }
  return {
    conversionContext: record.conversionContext,
    industry: record.industry,
    modelSelectionValue: model?.value ?? '',
    productId: product?.id ?? '',
    sourceRecordId: record.id,
    warnings,
  };
};
