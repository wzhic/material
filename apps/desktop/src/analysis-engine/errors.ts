import type { ModelApiErrorCode } from '../model/types';

export type AnalysisEngineErrorCode =
  | 'CANCELLED'
  | 'EVIDENCE_INVALID'
  | 'INPUT_INVALID'
  | 'MODEL_FAILED'
  | 'MODEL_OUTPUT_INVALID'
  | 'RULE_FAILED';

export class AnalysisEngineError extends Error {
  constructor(
    readonly code: AnalysisEngineErrorCode,
    message: string,
    readonly modelErrorCode: ModelApiErrorCode | null = null,
  ) {
    super(message);
    this.name = 'AnalysisEngineError';
  }
}
