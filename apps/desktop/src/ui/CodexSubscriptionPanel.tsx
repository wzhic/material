import React, {
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Button, Tag } from 'tdesign-react';

import {
  CodexDeviceLoginStarted,
  CodexRateLimitBucket,
  CodexRateLimitWindow,
  CodexSubscriptionApi,
  CodexSubscriptionState,
  CodexSubscriptionStatus,
} from '../codex-subscription/types';

type CodexDialog = 'device' | 'login' | 'logout' | 'test' | null;
type CodexBusyAction =
  | 'browserLogin'
  | 'cancelLogin'
  | 'deviceLogin'
  | 'logout'
  | 'openDevicePage'
  | 'refreshAccount'
  | 'refreshModels'
  | 'selectModel'
  | 'test'
  | null;

interface AccessibleDialogProps {
  busy?: boolean;
  children: ReactNode;
  description: string;
  footer: ReactNode;
  id: string;
  onClose: () => void;
  title: string;
}

export interface CodexSubscriptionPanelProps {
  /** Allows an in-memory API double to render deterministic signed-out/connected previews. */
  api?: CodexSubscriptionApi;
}

const focusableSelector = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const planNames: Readonly<Record<string, string>> = Object.freeze({
  business: 'ChatGPT Business',
  edu: 'ChatGPT Edu',
  enterprise: 'ChatGPT Enterprise',
  free: 'ChatGPT Free',
  go: 'ChatGPT Go',
  plus: 'ChatGPT Plus',
  pro: 'ChatGPT Pro',
});

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

export const formatCodexPlan = (planType: string | null): string => {
  if (!planType) return '套餐信息未提供';
  return planNames[planType.toLowerCase()] ?? `ChatGPT 套餐（${planType}）`;
};

export const formatRateLimitDuration = (minutes: number | null): string => {
  if (minutes === null) return '窗口信息未提供';
  if (minutes < 60) return `${minutes} 分钟窗口`;
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} 天窗口`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时窗口`;
  return `${minutes} 分钟窗口`;
};

export const codexStatusLabel = (status: CodexSubscriptionStatus): string => {
  switch (status) {
    case 'unavailable': return '组件不可用';
    case 'signedOut': return '未登录';
    case 'loginPending': return '登录中';
    case 'ready': return '已连接';
    case 'limited': return '额度受限';
    case 'testing': return '测试中';
    case 'error': return '需要处理';
    default: return '状态未知';
  }
};

export const shouldClearDeviceLogin = (status: CodexSubscriptionStatus): boolean =>
  status !== 'loginPending';

export const codexTestDisabledReason = (
  state: CodexSubscriptionState,
  busy: boolean,
): string | null => {
  if (busy || state.status === 'testing') return '当前操作完成前不能重复测试。';
  if (state.status === 'limited') return 'Codex 订阅额度当前受限，请等待重置后刷新状态。';
  if (state.status !== 'ready') return '登录并完成账号同步后才能测试。';
  if (state.models.length === 0) return '当前账号没有可用于测试的 Codex 模型。';
  if (!state.selectedModelId) return '请先明确选择一个 Codex 模型。';
  return null;
};

export const isCodexConnectedState = (state: CodexSubscriptionState): boolean => (
  ['limited', 'ready', 'testing'].includes(state.status)
  || (state.status === 'error'
    && (state.accountLabel !== null
      || state.planType !== null
      || state.models.length > 0
      || state.selectedModelId !== null))
);

const statusTheme = (
  status: CodexSubscriptionStatus,
): 'danger' | 'success' | 'warning' | undefined => {
  if (status === 'ready') return 'success';
  if (status === 'loginPending' || status === 'limited' || status === 'testing') {
    return 'warning';
  }
  if (status === 'unavailable' || status === 'error') return 'danger';
  return undefined;
};

const formatTimestamp = (value: string | null): string => {
  if (!value) return '未提供';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '未提供' : parsed.toLocaleString();
};

const AccessibleDialog = ({
  busy = false,
  children,
  description,
  footer,
  id,
  onClose,
  title,
}: AccessibleDialogProps): React.JSX.Element => {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const frame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      dialog?.querySelector<HTMLElement>(focusableSelector)?.focus();
      if (dialog && !dialog.contains(document.activeElement)) dialog.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      previouslyFocusedRef.current?.focus();
    };
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!busy) onClose();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector),
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) {
      event.preventDefault();
      dialogRef.current.focus();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const handleBackdrop = (event: MouseEvent<HTMLDivElement>): void => {
    if (!busy && event.currentTarget === event.target) onClose();
  };

  return (
    <div className="model-dialog-backdrop" onMouseDown={handleBackdrop}>
      <div
        aria-busy={busy}
        aria-describedby={`${id}-description`}
        aria-labelledby={`${id}-title`}
        aria-modal="true"
        className="model-dialog codex-dialog"
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="model-dialog-header">
          <div>
            <h2 id={`${id}-title`}>{title}</h2>
            <p id={`${id}-description`}>{description}</p>
          </div>
          <button
            aria-label={`关闭${title}对话框`}
            className="model-dialog-close"
            disabled={busy}
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </div>
        <div className="codex-dialog-body">{children}</div>
        <div className="model-dialog-actions codex-dialog-actions">{footer}</div>
      </div>
    </div>
  );
};

const RateLimitWindow = ({
  label,
  value,
}: {
  label: string;
  value: CodexRateLimitWindow;
}): React.JSX.Element => {
  const percent = Math.round(clampPercent(value.usedPercent));
  return (
    <div className="codex-rate-window">
      <div className="codex-rate-window-heading">
        <strong>{label}</strong>
        <span>{percent}% 已使用</span>
      </div>
      <progress
        aria-label={`${label}已使用 ${percent}%`}
        max={100}
        value={percent}
      />
      <span>
        {formatRateLimitDuration(value.windowDurationMins)}
        {' · '}
        {value.resetsAt ? `${formatTimestamp(value.resetsAt)} 重置` : '重置时间未提供'}
      </span>
    </div>
  );
};

const RateLimitBucket = ({ bucket }: { bucket: CodexRateLimitBucket }): React.JSX.Element => (
  <article className="codex-rate-bucket">
    <div className="codex-rate-bucket-title">
      <strong>{bucket.limitName ?? bucket.limitId}</strong>
      {bucket.rateLimitReachedType ? <Tag theme="warning">已达到限制</Tag> : null}
    </div>
    {bucket.primary ? <RateLimitWindow label="主要额度" value={bucket.primary} /> : null}
    {bucket.secondary ? <RateLimitWindow label="次要额度" value={bucket.secondary} /> : null}
    {!bucket.primary && !bucket.secondary ? (
      <span className="codex-muted-copy">OpenAI 暂未返回此额度窗口的详情。</span>
    ) : null}
  </article>
);

export const CodexSubscriptionPanel = ({
  api = window.materialApi.codexSubscription,
}: CodexSubscriptionPanelProps = {}): React.JSX.Element => {
  const [state, setState] = useState<CodexSubscriptionState | null>(null);
  const [busyAction, setBusyAction] = useState<CodexBusyAction>(null);
  const [dialog, setDialog] = useState<CodexDialog>(null);
  const [deviceLogin, setDeviceLogin] = useState<CodexDeviceLoginStarted | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const activeLoginIdRef = useRef<string | null>(null);
  const browserStartInFlightRef = useRef(false);
  const cancelInFlightRef = useRef(false);
  const cancelledLoginIdsRef = useRef(new Set<string>());
  const deviceStartInFlightRef = useRef(false);
  const supersededLoginIdsRef = useRef(new Set<string>());

  const loadState = useCallback(async (showLoading = false): Promise<void> => {
    if (showLoading) setLoading(true);
    const result = await api.getState();
    if (showLoading) setLoading(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setError('');
    setState(result.data);
    activeLoginIdRef.current = result.data.pendingLoginId;
    if (shouldClearDeviceLogin(result.data.status)) {
      setDeviceLogin(null);
      setDialog((current) => current === 'device' ? null : current);
    }
  }, [api]);

  useEffect(() => {
    const unsubscribeState = api.onStateChanged((next) => {
      setState(next);
      activeLoginIdRef.current = next.pendingLoginId;
      if (shouldClearDeviceLogin(next.status)) {
        setDeviceLogin(null);
        setDialog((current) => current === 'device' ? null : current);
      }
    });
    const unsubscribeLogin = api.onLoginCompleted((event) => {
      if (event.loginId && supersededLoginIdsRef.current.delete(event.loginId)) {
        cancelledLoginIdsRef.current.delete(event.loginId);
        return;
      }
      const activeLoginId = activeLoginIdRef.current;
      const wasCancelled = event.loginId
        ? cancelledLoginIdsRef.current.delete(event.loginId)
        : false;
      if (event.loginId && activeLoginId && event.loginId !== activeLoginId) return;
      if (event.success) {
        setError('');
        setMessage('Codex 订阅登录成功，正在同步账号、额度和模型。');
      } else if (wasCancelled) {
        setError('');
        setMessage('Codex 订阅登录已取消，API Key 模型配置未受影响。');
      } else {
        setMessage('');
        setError(event.error?.message ?? 'Codex 订阅登录未完成，请重新尝试。');
      }
      activeLoginIdRef.current = null;
      setDeviceLogin(null);
      setDialog((current) => current === 'device' ? null : current);
      void loadState();
    });
    const unsubscribeLimits = api.onRateLimitsChanged((limits) => {
      setState((current) => current ? { ...current, rateLimits: limits } : current);
    });
    void loadState(true);
    return () => {
      unsubscribeState();
      unsubscribeLogin();
      unsubscribeLimits();
    };
  }, [api, loadState]);

  useEffect(() => {
    if (state?.status !== 'loginPending') return undefined;
    const timer = window.setInterval(() => void loadState(), 1_500);
    return () => window.clearInterval(timer);
  }, [loadState, state?.status]);

  const clearFeedback = (): void => {
    setError('');
    setMessage('');
  };

  const cancelLogin = async (): Promise<void> => {
    if (cancelInFlightRef.current || deviceStartInFlightRef.current) return;
    const loginId = activeLoginIdRef.current ?? state?.pendingLoginId ?? null;
    if (!loginId) {
      setDialog(null);
      setDeviceLogin(null);
      setError('当前页面没有可取消的登录标识，请刷新账号状态核对结果。');
      return;
    }
    cancelInFlightRef.current = true;
    setBusyAction('cancelLogin');
    cancelledLoginIdsRef.current.add(loginId);
    try {
      const result = await api.cancelLogin(loginId);
      if (!result.ok) {
        cancelledLoginIdsRef.current.delete(loginId);
        await loadState();
        setError(`取消登录未完成：${result.error.message}。已刷新当前账号状态。`);
        return;
      }
      activeLoginIdRef.current = null;
      setDialog(null);
      setDeviceLogin(null);
      await loadState();
      setError('');
      setMessage('Codex 订阅登录已取消，API Key 模型配置未受影响。');
    } finally {
      cancelInFlightRef.current = false;
      setBusyAction(null);
    }
  };

  const startBrowserLogin = async (): Promise<void> => {
    if (browserStartInFlightRef.current || deviceStartInFlightRef.current) return;
    browserStartInFlightRef.current = true;
    setBusyAction('browserLogin');
    clearFeedback();
    try {
      const result = await api.startBrowserLogin();
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      activeLoginIdRef.current = result.data.loginId;
      setDialog(null);
      setMessage('系统浏览器已打开。请在 OpenAI 页面完成登录后返回 Material。');
      await loadState();
    } finally {
      browserStartInFlightRef.current = false;
      setBusyAction(null);
    }
  };

  const startDeviceLogin = async (): Promise<void> => {
    if (deviceStartInFlightRef.current
      || browserStartInFlightRef.current
      || cancelInFlightRef.current) return;
    deviceStartInFlightRef.current = true;
    setBusyAction('deviceLogin');
    clearFeedback();
    try {
      const pendingId = activeLoginIdRef.current ?? state?.pendingLoginId ?? null;
      if (pendingId) {
        cancelledLoginIdsRef.current.add(pendingId);
        supersededLoginIdsRef.current.add(pendingId);
        const cancelled = await api.cancelLogin(pendingId);
        if (!cancelled.ok) {
          cancelledLoginIdsRef.current.delete(pendingId);
          supersededLoginIdsRef.current.delete(pendingId);
          await loadState();
          setError(`无法切换登录方式：${cancelled.error.message}。已刷新当前账号状态。`);
          return;
        }
        activeLoginIdRef.current = null;
      }
      const result = await api.startDeviceLogin();
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      activeLoginIdRef.current = result.data.loginId;
      setDeviceLogin(result.data);
      setDialog('device');
      await loadState();
    } finally {
      deviceStartInFlightRef.current = false;
      setBusyAction(null);
    }
  };

  const copyDeviceCode = async (): Promise<void> => {
    if (!deviceLogin) return;
    try {
      await navigator.clipboard.writeText(deviceLogin.userCode);
      setError('');
      setMessage('一次性设备码已复制。');
    } catch {
      setMessage('');
      setError('无法自动复制设备码，请选择代码后手动复制。');
    }
  };

  const openDeviceVerificationPage = async (): Promise<void> => {
    setBusyAction('openDevicePage');
    clearFeedback();
    try {
      const result = await api.openDeviceVerificationPage();
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setMessage('已在系统浏览器打开 OpenAI 设备验证页面。');
    } finally {
      setBusyAction(null);
    }
  };

  const refreshAccount = async (): Promise<void> => {
    setBusyAction('refreshAccount');
    clearFeedback();
    try {
      const result = await api.refreshAccount();
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setState(result.data);
      activeLoginIdRef.current = result.data.pendingLoginId;
      setMessage('Codex 账号、模型与额度状态已刷新。');
    } finally {
      setBusyAction(null);
    }
  };

  const refreshModels = async (): Promise<void> => {
    setBusyAction('refreshModels');
    clearFeedback();
    const result = await api.refreshModels();
    if (!result.ok) {
      setBusyAction(null);
      setError(result.error.message);
      return;
    }
    await loadState();
    setBusyAction(null);
    setMessage(`已从当前 Codex 账号刷新 ${result.data.length} 个可用模型。`);
  };

  const selectModel = async (modelId: string): Promise<void> => {
    setBusyAction('selectModel');
    clearFeedback();
    const result = await api.selectModel(modelId || null);
    setBusyAction(null);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setState(result.data);
    setMessage(modelId ? 'Codex 订阅首选模型已更新。' : 'Codex 订阅模型选择已清空。');
  };

  const testSelectedModel = async (): Promise<void> => {
    setDialog(null);
    setBusyAction('test');
    clearFeedback();
    const result = await api.testSelectedModel();
    setBusyAction(null);
    await loadState();
    if (!result.ok) {
      setError(`Codex 测试调用失败：${result.error.message}`);
      return;
    }
    const returnedModel = result.data.returnedModelId === result.data.requestedModelId
      ? ''
      : `；服务报告实际模型 ${result.data.returnedModelId}，请核对别名或版本快照`;
    setMessage(
      `Codex 测试调用成功：请求模型 ${result.data.requestedModelId}${returnedModel}`
      + `；耗时 ${result.data.durationMs} 毫秒；${formatTimestamp(result.data.checkedAt)}`,
    );
  };

  const logout = async (): Promise<void> => {
    setDialog(null);
    setBusyAction('logout');
    clearFeedback();
    const result = await api.logout();
    setBusyAction(null);
    if (!result.ok) {
      setError(result.error.message);
      await loadState();
      return;
    }
    activeLoginIdRef.current = null;
    setDeviceLogin(null);
    await loadState();
    setMessage('已退出 Material 中的 Codex 订阅；API Key 模型配置未受影响。');
  };

  const stateBusy = busyAction !== null || state?.status === 'testing';
  const connected = state ? isCodexConnectedState(state) : false;
  const testDisabledReason = state ? codexTestDisabledReason(state, stateBusy) : null;
  const selectedModel = state?.models.find((model) => model.id === state.selectedModelId);
  const canRefresh = state?.status === 'ready' || state?.status === 'limited';

  return (
    <section
      aria-labelledby="codex-subscription-heading"
      className="model-config-list codex-subscription-section"
    >
      <div className="settings-section-heading">
        <div>
          <div className="codex-section-title">
            <h2 id="codex-subscription-heading">Codex 订阅</h2>
            <Tag theme="primary" variant="light">Beta</Tag>
          </div>
          <p>使用 ChatGPT 登录与订阅额度，无需填写 OpenAI API Key。</p>
        </div>
        {state ? (
          <Tag theme={statusTheme(state.status)} variant="light">
            {codexStatusLabel(state.status)}
          </Tag>
        ) : null}
      </div>

      {error && dialog === null ? (
        <div aria-live="assertive" className="settings-message is-error" role="alert">
          {error}
        </div>
      ) : null}
      {message && dialog === null ? (
        <div aria-live="polite" className="settings-message is-success" role="status">
          {message}
        </div>
      ) : null}

      {loading && !state ? (
        <div className="codex-subscription-loading" role="status">
          <span className="model-loading-indicator" aria-hidden="true" />
          <span>正在读取 Codex 订阅状态…</span>
        </div>
      ) : !state ? (
        <div className="codex-subscription-card">
          <strong>无法读取 Codex 订阅状态</strong>
          <p>API Key 模型不受影响；请检查本地 Codex 运行组件后重试。</p>
          <Button onClick={() => void loadState(true)} size="small" variant="outline">
            重新加载
          </Button>
        </div>
      ) : state.status === 'unavailable' ? (
        <div className="codex-subscription-card is-warning">
          <strong>Codex 运行组件不可用</strong>
          <p>{state.lastError?.message ?? '请修复或升级本地 Codex 组件后重试。'}</p>
          <Button
            disabled={stateBusy}
            onClick={() => void refreshAccount()}
            size="small"
            variant="outline"
          >
            重新检查
          </Button>
        </div>
      ) : !connected ? (
        <div aria-busy={state.status === 'loginPending'} className="codex-subscription-card">
          <div className="codex-account-heading">
            <div>
              <strong>
                {state.status === 'loginPending' ? '正在等待 ChatGPT 登录' : '连接 Codex 订阅'}
              </strong>
              <p>
                {state.status === 'loginPending'
                  ? '请在 OpenAI 页面完成授权；Material 会等待安全账号状态更新。'
                  : state.lastError?.code === 'SIGNED_OUT'
                    ? '登录已退出或可能过期，请重新连接后同步账号状态。'
                    : '登录后可发现当前账号可用模型并执行受控连通测试。'}
              </p>
            </div>
          </div>
          {state.lastError ? (
            <div className="codex-inline-error" role="alert">{state.lastError.message}</div>
          ) : null}
          {state.status === 'error' ? (
            <p className="codex-recovery-copy">
              若当前离线，请恢复网络后重试；若工作区禁用了 Codex，请联系管理员核对权限。
            </p>
          ) : null}
          <div className="codex-card-actions">
            {state.status === 'loginPending' ? (
              <>
                <Button
                  disabled={!(activeLoginIdRef.current ?? state.pendingLoginId) || stateBusy}
                  loading={busyAction === 'cancelLogin'}
                  onClick={() => void cancelLogin()}
                  size="small"
                  variant="outline"
                >
                  取消登录
                </Button>
                <Button
                  disabled={stateBusy}
                  onClick={() => void startDeviceLogin()}
                  size="small"
                  variant="text"
                >
                  改用设备码（Beta）
                </Button>
              </>
            ) : (
              <>
                <Button
                  disabled={stateBusy}
                  onClick={() => {
                    clearFeedback();
                    setDialog('login');
                  }}
                  size="small"
                  theme="primary"
                >
                  使用 ChatGPT 登录
                </Button>
                <Button
                  disabled={stateBusy}
                  onClick={() => void startDeviceLogin()}
                  size="small"
                  variant="outline"
                >
                  使用设备码（Beta）
                </Button>
              </>
            )}
          </div>
          {state.status === 'loginPending'
            && !(activeLoginIdRef.current ?? state.pendingLoginId) ? (
            <p className="codex-disabled-reason" role="status">
              此页面没有原登录标识，不能直接取消；登录结果将以安全账号快照为准。
            </p>
          ) : null}
          <div className="codex-data-notice">
            登录、模型刷新与测试会连接 OpenAI。测试会占用 Codex 订阅额度或 credits，
            不使用 API Key 余额。
          </div>
        </div>
      ) : (
        <div aria-busy={stateBusy} className="codex-subscription-card">
          <div className="codex-account-heading">
            <div>
              <strong>{state.accountLabel ?? '当前 ChatGPT 账号'}</strong>
              <p>{formatCodexPlan(state.planType)} · ChatGPT 登录</p>
            </div>
            <span className="codex-account-source">订阅额度</span>
          </div>

          {state.lastError ? (
            <div className="codex-inline-error" role="alert">{state.lastError.message}</div>
          ) : null}
          {state.status === 'error' ? (
            <p className="codex-recovery-copy">
              若当前离线，请恢复网络后刷新账号；若工作区禁用了 Codex，请联系管理员核对权限。
            </p>
          ) : null}
          {state.status === 'limited' ? (
            <div className="codex-limit-warning" role="alert">
              Codex 订阅额度当前受限。不会自动切换到 API Key，请等待重置后刷新状态。
            </div>
          ) : null}
          {state.status !== 'error' && state.models.length === 0 ? (
            <div className="codex-limit-warning" role="status">
              当前账号没有可用 Codex 模型。请刷新账号，并核对套餐或工作区管理员权限。
            </div>
          ) : null}

          <div className="codex-rate-limits" aria-label="Codex 订阅限额">
            <div className="codex-rate-limits-heading">
              <strong>套餐与限额</strong>
              <span>
                {state.rateLimits
                  ? `检查于 ${formatTimestamp(state.rateLimits.checkedAt)}`
                  : 'OpenAI 暂未返回额度信息'}
              </span>
            </div>
            {state.rateLimits?.buckets.map((bucket) => (
              <RateLimitBucket bucket={bucket} key={bucket.limitId} />
            ))}
            {state.rateLimits && state.rateLimits.buckets.length === 0 ? (
              <span className="codex-muted-copy">当前没有可显示的额度窗口。</span>
            ) : null}
            {state.rateLimits?.resetCreditsAvailable !== null
              && state.rateLimits?.resetCreditsAvailable !== undefined ? (
                <span className="codex-muted-copy">
                  可用重置 credits：{state.rateLimits.resetCreditsAvailable}。
                  Material 不会自动使用。
                </span>
              ) : null}
          </div>

          <label className="form-field codex-model-select" htmlFor="codex-subscription-model">
            <span className="field-label">Codex 首选模型</span>
            <select
              aria-describedby="codex-model-help"
              disabled={!canRefresh || state.models.length === 0 || stateBusy}
              id="codex-subscription-model"
              onChange={(event) => void selectModel(event.target.value)}
              value={state.selectedModelId ?? ''}
            >
              <option value="">{state.models.length ? '请选择模型' : '当前没有可用模型'}</option>
              {state.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName} · {model.id}{model.isDefault ? '（Codex 推荐）' : ''}
                </option>
              ))}
            </select>
            <small id="codex-model-help">
              作为订阅内首选模型保存；账号 ready 且额度未受限时，目录中的模型会进入新建分析候选。
            </small>
          </label>

          <div className="codex-card-actions">
            <Button
              disabled={stateBusy}
              loading={busyAction === 'refreshAccount'}
              onClick={() => void refreshAccount()}
              size="small"
              variant="outline"
            >
              刷新账号状态
            </Button>
            <Button
              disabled={!canRefresh || stateBusy}
              loading={busyAction === 'refreshModels'}
              onClick={() => void refreshModels()}
              size="small"
              variant="outline"
            >
              刷新模型
            </Button>
            <Button
              aria-describedby={testDisabledReason ? 'codex-test-disabled-reason' : undefined}
              disabled={testDisabledReason !== null}
              loading={busyAction === 'test' || state.status === 'testing'}
              onClick={() => {
                clearFeedback();
                setDialog('test');
              }}
              size="small"
              variant="outline"
            >
              测试调用
            </Button>
            <Button
              disabled={stateBusy}
              loading={busyAction === 'logout'}
              onClick={() => {
                clearFeedback();
                setDialog('logout');
              }}
              size="small"
              theme="danger"
              variant="text"
            >
              退出登录
            </Button>
          </div>
          {testDisabledReason ? (
            <p className="codex-disabled-reason" id="codex-test-disabled-reason">
              测试调用不可用：{testDisabledReason}
            </p>
          ) : null}
          <div className="codex-data-notice">
            真实分析会消耗当前账号的 Codex 订阅额度或 credits；V1 仅发送本地提取的
            结构化文本证据，不发送原始视频、图片或音频。Codex 与 API Key 不会自动切换。
          </div>
        </div>
      )}

      {dialog === 'login' ? (
        <AccessibleDialog
          busy={busyAction === 'browserLogin' || busyAction === 'deviceLogin'}
          description="Material 不会读取你的 ChatGPT 密码；浏览器登录地址不会返回 renderer。"
          footer={(
            <>
              <Button disabled={busyAction !== null} onClick={() => setDialog(null)} variant="outline">
                取消
              </Button>
              <Button
                disabled={busyAction !== null}
                loading={busyAction === 'deviceLogin'}
                onClick={() => void startDeviceLogin()}
                variant="outline"
              >
                使用设备码（Beta）
              </Button>
              <Button
                disabled={busyAction !== null}
                loading={busyAction === 'browserLogin'}
                onClick={() => void startBrowserLogin()}
                theme="primary"
              >
                继续并打开浏览器
              </Button>
            </>
          )}
          id="codex-login-dialog"
          onClose={() => setDialog(null)}
          title="连接 Codex 订阅"
        >
          {error ? (
            <div aria-live="assertive" className="settings-message is-error" role="alert">
              {error}
            </div>
          ) : null}
          {message ? (
            <div aria-live="polite" className="settings-message is-success" role="status">
              {message}
            </div>
          ) : null}
          <div className="codex-dialog-copy">
            <strong>即将在系统浏览器打开 OpenAI 登录页</strong>
            <p>
              登录成功后，Material 会读取主进程提供的掩码账号、套餐、额度和可用模型摘要。
              测试或你明确启动的真实分析会占用 Codex 订阅额度或 credits，不使用 API Key。
            </p>
          </div>
        </AccessibleDialog>
      ) : null}

      {dialog === 'device' && deviceLogin ? (
        <AccessibleDialog
          busy={busyAction !== null}
          description="一次性代码仅用于本次授权；复制后会进入系统剪贴板，Material 不保存。"
          footer={(
            <>
              <Button
                disabled={busyAction !== null}
                loading={busyAction === 'cancelLogin'}
                onClick={() => void cancelLogin()}
                variant="outline"
              >
                取消登录
              </Button>
              <Button disabled={busyAction !== null} onClick={() => void copyDeviceCode()}>
                复制代码
              </Button>
              <Button
                disabled={busyAction !== null}
                loading={busyAction === 'openDevicePage'}
                onClick={() => void openDeviceVerificationPage()}
                theme="primary"
              >
                打开验证页面
              </Button>
            </>
          )}
          id="codex-device-dialog"
          onClose={() => void cancelLogin()}
          title="使用设备码登录"
        >
          {error ? (
            <div aria-live="assertive" className="settings-message is-error" role="alert">
              {error}
            </div>
          ) : null}
          {message ? (
            <div aria-live="polite" className="settings-message is-success" role="status">
              {message}
            </div>
          ) : null}
          <ol className="codex-device-steps">
            <li>在系统浏览器打开 OpenAI 设备验证页面。</li>
            <li>输入下面的一次性代码并完成授权。</li>
            <li>返回 Material，页面会等待安全登录结果。</li>
          </ol>
          <label className="codex-device-code" htmlFor="codex-device-code-value">
            <span>一次性设备码</span>
            <input
              id="codex-device-code-value"
              onFocus={(event) => event.currentTarget.select()}
              readOnly
              value={deviceLogin.userCode}
            />
          </label>
        </AccessibleDialog>
      ) : null}

      {dialog === 'test' && state?.selectedModelId ? (
        <AccessibleDialog
          busy={busyAction === 'test'}
          description="本次只确认一个受控 Codex 测试回合，不授权素材分析或模型切换。"
          footer={(
            <>
              <Button disabled={busyAction !== null} onClick={() => setDialog(null)} variant="outline">
                取消
              </Button>
              <Button
                disabled={busyAction !== null}
                loading={busyAction === 'test'}
                onClick={() => void testSelectedModel()}
                theme="primary"
              >
                确认测试
              </Button>
            </>
          )}
          id="codex-test-dialog"
          onClose={() => setDialog(null)}
          title="测试 Codex 订阅模型"
        >
          <dl className="codex-confirm-summary">
            <div><dt>账号</dt><dd>{state.accountLabel ?? '当前 ChatGPT 账号'}</dd></div>
            <div><dt>模型</dt><dd>{selectedModel?.displayName ?? state.selectedModelId}</dd></div>
            <div>
              <dt>发送内容</dt>
              <dd>{'固定非业务文本，仅要求返回 {"result":"OK"}'}</dd>
            </div>
            <div>
              <dt>数据边界</dt>
              <dd>不发送用户素材、分析内容、文件或历史消息；不允许工具或额外网络</dd>
            </div>
            <div>
              <dt>调用边界</dt>
              <dd>
                Material 失败后不再创建第二回合、不换模型或回退 API Key；
                官方运行时可能在该回合内做传输恢复
              </dd>
            </div>
            <div><dt>额度</dt><dd>消耗 Codex 订阅额度或 credits，不使用 API Key</dd></div>
          </dl>
        </AccessibleDialog>
      ) : null}

      {dialog === 'logout' && state ? (
        <AccessibleDialog
          busy={busyAction === 'logout'}
          description="退出只清除 Material 中的 Codex 订阅连接。"
          footer={(
            <>
              <Button disabled={busyAction !== null} onClick={() => setDialog(null)} variant="outline">
                取消
              </Button>
              <Button
                disabled={busyAction !== null}
                loading={busyAction === 'logout'}
                onClick={() => void logout()}
                theme="danger"
              >
                确认退出
              </Button>
            </>
          )}
          id="codex-logout-dialog"
          onClose={() => setDialog(null)}
          title="退出 Codex 订阅"
        >
          <div className="codex-dialog-copy">
            <strong>{state.accountLabel ?? '当前 ChatGPT 账号'}</strong>
            <p>
              退出后会清除订阅模型选择；API Key 模型配置和当前分析草稿不会删除。
            </p>
          </div>
        </AccessibleDialog>
      ) : null}
    </section>
  );
};
