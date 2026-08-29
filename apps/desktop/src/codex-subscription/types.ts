export const CODEX_DEVICE_VERIFICATION_URL =
  'https://auth.openai.com/codex/device' as const;

export const CODEX_SUBSCRIPTION_CONFIGURATION_ID = 'codex-subscription' as const;
export const CODEX_SUBSCRIPTION_CONFIGURATION_DISPLAY_NAME = 'Codex 订阅（Beta）' as const;

export type CodexSubscriptionStatus =
  | 'unavailable'
  | 'signedOut'
  | 'loginPending'
  | 'ready'
  | 'limited'
  | 'testing'
  | 'error';

export type CodexSubscriptionErrorCode =
  | 'INVALID_INPUT'
  | 'RUNTIME_UNAVAILABLE'
  | 'PROTOCOL_ERROR'
  | 'SIGNED_OUT'
  | 'LOGIN_IN_PROGRESS'
  | 'LOGIN_FAILED'
  | 'NO_MODEL_SELECTED'
  | 'MODEL_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'TEST_FAILED'
  | 'TEST_TIMEOUT'
  | 'SECURITY_VIOLATION'
  | 'UNKNOWN';

export interface CodexSubscriptionPublicError {
  code: CodexSubscriptionErrorCode;
  message: string;
}

export type CodexSubscriptionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: CodexSubscriptionPublicError };

export interface CodexReasoningEffortSummary {
  reasoningEffort: string;
  description: string | null;
}

export interface CodexModelSummary {
  /** Stable catalog preset identifier used as the UI selection key. */
  id: string;
  /** Authoritative provider model slug used for App Server requests. */
  modelSlug: string;
  displayName: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: CodexReasoningEffortSummary[];
  inputModalities: string[];
}

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: string | null;
}

export interface CodexRateLimitBucket {
  limitId: string;
  limitName: string | null;
  planType: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  rateLimitReachedType: string | null;
  spendControlReached?: boolean;
}

export interface CodexRateLimitsSummary {
  checkedAt: string;
  buckets: CodexRateLimitBucket[];
  resetCreditsAvailable: number | null;
}

export interface CodexSubscriptionState {
  status: CodexSubscriptionStatus;
  /** Masked in the main process; the renderer never receives the raw email. */
  accountLabel: string | null;
  planType: string | null;
  /** Opaque App Server nonce used only to cancel the active login after reload. */
  pendingLoginId: string | null;
  selectedModelId: string | null;
  models: CodexModelSummary[];
  rateLimits: CodexRateLimitsSummary | null;
  lastError: CodexSubscriptionPublicError | null;
}

export interface CodexBrowserLoginStarted {
  loginId: string;
}

export interface CodexDeviceLoginStarted {
  loginId: string;
  verificationUrl: typeof CODEX_DEVICE_VERIFICATION_URL;
  userCode: string;
}

export interface CodexLoginCompletedEvent {
  loginId: string | null;
  success: boolean;
  error: CodexSubscriptionPublicError | null;
}

export interface CodexConnectivityTestResult {
  checkedAt: string;
  durationMs: number;
  requestedModelId: string;
  returnedModelId: string;
  planType: string | null;
}

export interface CodexSubscriptionApi {
  getState(): Promise<CodexSubscriptionResult<CodexSubscriptionState>>;
  startBrowserLogin(): Promise<CodexSubscriptionResult<CodexBrowserLoginStarted>>;
  startDeviceLogin(): Promise<CodexSubscriptionResult<CodexDeviceLoginStarted>>;
  openDeviceVerificationPage(): Promise<CodexSubscriptionResult<null>>;
  cancelLogin(loginId: string): Promise<CodexSubscriptionResult<null>>;
  refreshAccount(): Promise<CodexSubscriptionResult<CodexSubscriptionState>>;
  refreshModels(): Promise<CodexSubscriptionResult<CodexModelSummary[]>>;
  selectModel(modelId: string | null): Promise<CodexSubscriptionResult<CodexSubscriptionState>>;
  getRateLimits(): Promise<CodexSubscriptionResult<CodexRateLimitsSummary | null>>;
  testSelectedModel(): Promise<CodexSubscriptionResult<CodexConnectivityTestResult>>;
  logout(): Promise<CodexSubscriptionResult<null>>;
  onStateChanged(listener: (state: CodexSubscriptionState) => void): () => void;
  onLoginCompleted(listener: (event: CodexLoginCompletedEvent) => void): () => void;
  onRateLimitsChanged(listener: (limits: CodexRateLimitsSummary) => void): () => void;
}

export const CODEX_SUBSCRIPTION_IPC_CHANNELS = {
  cancelLogin: 'codex-subscription:cancel-login',
  getRateLimits: 'codex-subscription:get-rate-limits',
  getState: 'codex-subscription:get-state',
  loginCompleted: 'codex-subscription:login-completed',
  logout: 'codex-subscription:logout',
  openDeviceVerificationPage: 'codex-subscription:open-device-verification-page',
  rateLimitsChanged: 'codex-subscription:rate-limits-changed',
  refreshAccount: 'codex-subscription:refresh-account',
  refreshModels: 'codex-subscription:refresh-models',
  selectModel: 'codex-subscription:select-model',
  startBrowserLogin: 'codex-subscription:start-browser-login',
  startDeviceLogin: 'codex-subscription:start-device-login',
  stateChanged: 'codex-subscription:state-changed',
  testSelectedModel: 'codex-subscription:test-selected-model',
} as const;
