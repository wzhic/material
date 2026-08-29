import {
  CodexSubscriptionErrorCode,
  CodexSubscriptionPublicError,
} from './types';

const SAFE_MESSAGES: Record<CodexSubscriptionErrorCode, string> = {
  INVALID_INPUT: 'Codex 订阅操作参数无效',
  RUNTIME_UNAVAILABLE: 'Codex 运行时不可用，请重新安装或更新应用',
  PROTOCOL_ERROR: 'Codex 运行时返回了无法识别的响应',
  SIGNED_OUT: '请先登录 ChatGPT/Codex 订阅账户',
  LOGIN_IN_PROGRESS: '已有 Codex 登录流程正在进行',
  LOGIN_FAILED: 'Codex 登录未完成，请重试',
  NO_MODEL_SELECTED: '请先选择一个 Codex 模型',
  MODEL_UNAVAILABLE: '所选 Codex 模型当前不可用，请刷新模型列表',
  RATE_LIMITED: 'Codex 订阅额度当前不可用，请在额度恢复后重试',
  TEST_FAILED: 'Codex 模型连通性测试失败',
  TEST_TIMEOUT: 'Codex 模型连通性测试在 60 秒内未完成',
  SECURITY_VIOLATION: 'Codex 测试尝试使用未授权能力，已终止',
  UNKNOWN: 'Codex 订阅操作失败，请重试',
};

export class CodexSubscriptionError extends Error {
  readonly code: CodexSubscriptionErrorCode;

  constructor(code: CodexSubscriptionErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = 'CodexSubscriptionError';
    this.code = code;
  }
}

export const toPublicCodexError = (error: unknown): CodexSubscriptionPublicError => {
  const code = error instanceof CodexSubscriptionError ? error.code : 'UNKNOWN';
  return { code, message: SAFE_MESSAGES[code] };
};
