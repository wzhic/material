import { AnalysisRuleError } from './errors';
import {
  ReportTagResult,
  TagPackageDefinition,
  TagValidationInput,
} from './types';

const FACET_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const EVIDENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const normalizeTagText = (value: string): string =>
  value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('zh-CN');

const validateEvidence = (
  ids: readonly string[],
  known: ReadonlySet<string>,
  label: string,
): string[] => {
  if (
    ids.length === 0
    || ids.length > 32
    || new Set(ids).size !== ids.length
    || ids.some((id) => !EVIDENCE_ID_PATTERN.test(id) || !known.has(id))
  ) {
    throw new AnalysisRuleError('TAG_INVALID', `${label}必须引用当次已知证据`);
  }
  return [...ids];
};

export const validateReportTags = (
  rules: TagPackageDefinition,
  input: TagValidationInput,
): ReportTagResult[] => {
  if (input.dynamicTags.length > 24 || input.fixedTags.length > rules.fixedTags.length) {
    throw new AnalysisRuleError('TAG_INVALID', '单次报告标签数量超过上限');
  }
  const definitions = new Map(rules.fixedTags.map((tag) => [tag.id, tag]));
  const fixedLabels = new Set(
    rules.fixedTags.map((tag) => normalizeTagText(tag.label)),
  );
  const fixedIds = new Set(rules.fixedTags.map((tag) => normalizeTagText(tag.id)));
  const seenFixed = new Set<string>();
  const fixedResults = input.fixedTags.map((item) => {
    const definition = definitions.get(item.tagId);
    if (!definition || seenFixed.has(item.tagId)) {
      throw new AnalysisRuleError('TAG_INVALID', '固定标签不存在或重复');
    }
    seenFixed.add(item.tagId);
    return {
      evidenceIds: validateEvidence(item.evidenceIds, input.evidenceIds, definition.label),
      facet: definition.facet,
      id: definition.id,
      kind: 'fixed' as const,
      label: definition.label,
      origin: 'product_rule' as const,
    };
  });

  const seenDynamic = new Set<string>();
  const dynamicResults = input.dynamicTags.map((item, index) => {
    const label = item.label.normalize('NFKC').trim().replace(/\s+/gu, ' ');
    const normalized = normalizeTagText(label);
    const key = `${item.facet}:${normalized}`;
    if (
      !label
      || label.length > 40
      || !FACET_PATTERN.test(item.facet)
      || !['fusion', 'model', 'tool'].includes(item.origin)
      || fixedLabels.has(normalized)
      || fixedIds.has(normalized)
      || seenDynamic.has(key)
    ) {
      throw new AnalysisRuleError(
        'TAG_INVALID',
        '动态标签无效、重复或覆盖了固定标签',
      );
    }
    seenDynamic.add(key);
    return {
      evidenceIds: validateEvidence(item.evidenceIds, input.evidenceIds, label),
      facet: item.facet,
      id: `dynamic.${index + 1}`,
      kind: 'dynamic' as const,
      label,
      origin: item.origin,
    };
  });
  return [...fixedResults, ...dynamicResults];
};
