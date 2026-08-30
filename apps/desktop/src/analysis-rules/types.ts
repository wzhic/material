export type AnalysisIndustry = 'apparel' | 'game';
export type AnalysisMediaKind = 'image' | 'video';
export type AnalysisGoal = 'acquisition_or_reactivation' | 'purchase_conversion';

export type ReportSectionId =
  | 'context'
  | 'cta'
  | 'diagnosis'
  | 'emotion'
  | 'evidence'
  | 'limitations'
  | 'overview'
  | 'product_or_gameplay'
  | 'recommendations'
  | 'selling_points'
  | 'structure'
  | 'tags'
  | 'timeline'
  | 'visuals'
  | 'voice_and_sound';

export interface ReportSectionDefinition {
  id: ReportSectionId;
  label: string;
  required: boolean;
}

export interface FixedTagDefinition {
  description: string;
  facet: string;
  id: string;
  label: string;
}

export interface TemplateDefinition {
  goal: AnalysisGoal;
  id: string;
  industry: AnalysisIndustry;
  mediaKind: AnalysisMediaKind;
  sections: ReportSectionDefinition[];
  version: string;
}

export interface TagPackageDefinition {
  fixedTags: FixedTagDefinition[];
  id: string;
  version: string;
}

export interface ScoringDimensionDefinition {
  description: string;
  evidenceKinds: string[];
  id: string;
  label: string;
  weight: number;
}

export interface ScoringRuleDefinition {
  dimensions: ScoringDimensionDefinition[];
  id: string;
  minimumCoverage: number;
  missingEvidencePolicy: 'renormalize_scored';
  version: string;
}

export interface AnalysisRulePackage {
  packageId: string;
  packageVersion: string;
  schemaVersion: 1;
  scoring: ScoringRuleDefinition;
  tags: TagPackageDefinition;
  template: TemplateDefinition;
}

export interface RulePackageSummary {
  goal: AnalysisGoal;
  industry: AnalysisIndustry;
  mediaKind: AnalysisMediaKind;
  packageId: string;
  packageVersion: string;
  scoringRuleId: string;
  scoringRuleVersion: string;
  tagPackageId: string;
  tagPackageVersion: string;
  templateId: string;
  templateVersion: string;
}

export interface AnalysisRuleSnapshot {
  package: AnalysisRulePackage;
  schemaVersion: 1;
}

export type DimensionAssessment =
  | {
      dimensionId: string;
      evidenceIds: string[];
      score: number;
      status: 'scored';
    }
  | {
      dimensionId: string;
      evidenceIds: string[];
      score?: never;
      status: 'insufficient_evidence' | 'not_applicable';
    };

export interface ScoredDimension {
  contribution: number | null;
  dimensionId: string;
  evidenceIds: string[];
  label: string;
  normalizedWeight: number | null;
  score: number | null;
  status: DimensionAssessment['status'];
  weight: number;
}

export interface MaterialScoreResult {
  coverage: number;
  dimensions: ScoredDimension[];
  limitations: string[];
  scoringRuleId: string;
  scoringRuleVersion: string;
  status: 'insufficient_evidence' | 'scored';
  total: number | null;
}

export type TagOrigin = 'fusion' | 'model' | 'tool';

export interface FixedTagInput {
  evidenceIds: string[];
  tagId: string;
}

export interface DynamicTagInput {
  evidenceIds: string[];
  facet: string;
  label: string;
  origin: TagOrigin;
}

export interface ReportTagResult {
  evidenceIds: string[];
  facet: string;
  id: string;
  kind: 'dynamic' | 'fixed';
  label: string;
  origin: TagOrigin | 'product_rule';
}

export interface TagValidationInput {
  dynamicTags: DynamicTagInput[];
  evidenceIds: ReadonlySet<string>;
  fixedTags: FixedTagInput[];
}
