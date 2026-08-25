import type { MaterialSession } from '../media/types';
import type { ProductListItem } from '../product/types';
import type { AnalysisRecord } from '../record/types';

export interface ReanalysisModelOption {
  configurationDisplayName: string;
  modelId: string;
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
  const model = models.find((item) =>
    item.configurationDisplayName === record.run.modelConfigurationName
    && item.modelId === record.run.modelId);
  if (!model) {
    warnings.push('原模型配置已删除或不可用，请显式选择模型后再启动。');
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
