import { AnalysisRuleError } from './errors';
import {
  AnalysisIndustry,
  AnalysisMediaKind,
  AnalysisRulePackage,
  AnalysisRuleSnapshot,
  RulePackageSummary,
} from './types';
import { cloneRulePackage, parseRulePackage } from './validation';

const packageKey = (id: string, version: string): string => `${id}@${version}`;
const selectionKey = (industry: AnalysisIndustry, mediaKind: AnalysisMediaKind): string =>
  `${industry}:${mediaKind}`;

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
};

const summarize = (item: AnalysisRulePackage): RulePackageSummary => ({
  goal: item.template.goal,
  industry: item.template.industry,
  mediaKind: item.template.mediaKind,
  packageId: item.packageId,
  packageVersion: item.packageVersion,
  scoringRuleId: item.scoring.id,
  scoringRuleVersion: item.scoring.version,
  tagPackageId: item.tags.id,
  tagPackageVersion: item.tags.version,
  templateId: item.template.id,
  templateVersion: item.template.version,
});

export class AnalysisRuleRegistry {
  private readonly active = new Map<string, string>();
  private readonly packages = new Map<string, AnalysisRulePackage>();

  register(value: unknown, activate = false): RulePackageSummary {
    const parsed = parseRulePackage(value);
    const key = packageKey(parsed.packageId, parsed.packageVersion);
    if (this.packages.has(key)) {
      throw new AnalysisRuleError('DUPLICATE_RULE', `规则包已注册：${key}`);
    }
    const sameContract = [...this.packages.values()].find((item) =>
      item.template.id === parsed.template.id
      && item.template.version === parsed.template.version,
    );
    if (sameContract) {
      throw new AnalysisRuleError(
        'DUPLICATE_RULE',
        `模板版本已由其他规则包注册：${parsed.template.id}@${parsed.template.version}`,
      );
    }
    this.packages.set(key, cloneRulePackage(parsed));
    if (activate) this.activate(parsed.packageId, parsed.packageVersion);
    return summarize(parsed);
  }

  activate(packageId: string, packageVersion: string): void {
    const item = this.packages.get(packageKey(packageId, packageVersion));
    if (!item) {
      throw new AnalysisRuleError('RULE_NOT_FOUND', '待启用的规则包不存在');
    }
    this.active.set(
      selectionKey(item.template.industry, item.template.mediaKind),
      packageKey(item.packageId, item.packageVersion),
    );
  }

  resolve(industry: AnalysisIndustry, mediaKind: AnalysisMediaKind): AnalysisRulePackage {
    const activeKey = this.active.get(selectionKey(industry, mediaKind));
    const item = activeKey ? this.packages.get(activeKey) : undefined;
    if (!item) {
      throw new AnalysisRuleError('RULE_NOT_FOUND', `没有启用的 ${industry}/${mediaKind} 规则包`);
    }
    return cloneRulePackage(item);
  }

  resolveVersion(packageId: string, packageVersion: string): AnalysisRulePackage {
    const item = this.packages.get(packageKey(packageId, packageVersion));
    if (!item) throw new AnalysisRuleError('RULE_NOT_FOUND', '指定规则包版本不存在');
    return cloneRulePackage(item);
  }

  list(): RulePackageSummary[] {
    return [...this.packages.values()]
      .map(summarize)
      .sort((left, right) =>
        `${left.industry}:${left.mediaKind}:${left.packageVersion}`
          .localeCompare(`${right.industry}:${right.mediaKind}:${right.packageVersion}`),
      );
  }

  snapshot(industry: AnalysisIndustry, mediaKind: AnalysisMediaKind): AnalysisRuleSnapshot {
    return deepFreeze({
      package: this.resolve(industry, mediaKind),
      schemaVersion: 1,
    });
  }
}
