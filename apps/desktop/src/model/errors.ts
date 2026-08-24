import { ModelApiErrorCode } from './types';

const SAFE_MESSAGES: Record<ModelApiErrorCode, string> = {
  AUTHENTICATION_FAILED: 'API Key 无效或已失效，请更新后重试',
  BALANCE_INSUFFICIENT: '模型账户余额不足，请处理后重试',
  CANCELLED: '模型调用已取消',
  CONFIGURATION_CHANGED: '模型配置已在其他窗口发生变化，请刷新后重试',
  CONFIGURATION_NOT_FOUND: '模型配置不存在或已删除',
  INVALID_INPUT: '模型配置或调用参数不完整',
  MODEL_NOT_AVAILABLE: '所选模型当前不可用，请刷新模型列表后重新选择',
  NETWORK_UNAVAILABLE: '无法连接模型服务，请检查网络后重试',
  PROVIDER_NOT_SUPPORTED: '当前版本不支持该模型供应商',
  RATE_LIMITED: '模型服务请求过多，请稍后由你决定是否重试',
  RESPONSE_INVALID: '模型服务返回了无法识别的响应',
  SECURE_STORAGE_UNAVAILABLE: '系统安全存储不可用，无法保存或读取 API Key',
  SERVICE_UNAVAILABLE: '模型服务暂时不可用，请稍后由你决定是否重试',
  TIMEOUT: '模型服务响应超时，请检查网络后重试',
  UNKNOWN: '模型操作失败，请重试',
};

export class ModelServiceError extends Error {
  readonly code: ModelApiErrorCode;

  constructor(code: ModelApiErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = 'ModelServiceError';
    this.code = code;
  }
}

export const safeModelMessage = (code: ModelApiErrorCode): string =>
  SAFE_MESSAGES[code];
