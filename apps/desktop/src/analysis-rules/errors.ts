export type AnalysisRuleErrorCode =
  | 'ASSESSMENT_INVALID'
  | 'DUPLICATE_RULE'
  | 'RULE_NOT_FOUND'
  | 'RULE_PACKAGE_INVALID'
  | 'TAG_INVALID';

export class AnalysisRuleError extends Error {
  constructor(
    readonly code: AnalysisRuleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AnalysisRuleError';
  }
}
