import React, {
  KeyboardEvent,
  MouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Button, Tag } from 'tdesign-react';

import {
  ModelConfigurationSummary,
  ModelProviderInfo,
  ModelSettingsSnapshot,
} from '../model/types';

interface ModelSettingsPageProps {
  onChanged: () => void;
}

interface ConfigurationForm {
  apiKey: string;
  baseUrl: string;
  displayName: string;
  expectedWriteVersion: number | null;
  id: string | null;
  manualModelId: string;
  providerId: string;
}

const emptyForm = (providers: ModelProviderInfo[] = []): ConfigurationForm => ({
  apiKey: '',
  baseUrl: providers[0]?.baseUrl ?? '',
  displayName: '',
  expectedWriteVersion: null,
  id: null,
  manualModelId: '',
  providerId: providers[0]?.id ?? '',
});

const statusLabel = (
  configuration: ModelConfigurationSummary,
  providerAvailable: boolean,
): string => {
  if (!providerAvailable) return 'Provider 不可用';
  if (configuration.connectionStatus === 'ready') return '连接正常';
  if (configuration.connectionStatus === 'error') return '验证失败';
  return '待验证';
};

const focusableSelector = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export const ModelSettingsPage = ({
  onChanged,
}: ModelSettingsPageProps): React.JSX.Element => {
  const [snapshot, setSnapshot] = useState<ModelSettingsSnapshot | null>(null);
  const [form, setForm] = useState<ConfigurationForm>(emptyForm());
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState('');
  const [error, setError] = useState('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async (): Promise<ModelSettingsSnapshot | null> => {
    setLoading(true);
    const result = await window.materialApi.models.getSettings();
    setLoading(false);
    if (!result.ok) {
      setError(result.error.message);
      return null;
    }
    setSnapshot(result.data);
    setForm((current) => current.providerId
      ? current
      : {
          ...current,
          baseUrl: result.data.providers[0]?.baseUrl ?? '',
          providerId: result.data.providers[0]?.id ?? '',
        });
    return result.data;
  }, []);

  useEffect(() => {
    setError('');
    void load();
  }, [load]);

  useEffect(() => {
    if (!isDialogOpen) return undefined;
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusFrame = window.requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>(focusableSelector)?.focus();
    });
    return () => {
      window.cancelAnimationFrame(focusFrame);
      previouslyFocusedRef.current?.focus();
    };
  }, [isDialogOpen]);

  const selectedProvider = snapshot?.providers.find(
    (provider) => provider.id === form.providerId,
  );
  const secureStorageReady = snapshot?.secureStorage.available ?? false;
  const anyActionBusy = busyAction !== null;
  const saveDisabled = !secureStorageReady
    || !selectedProvider
    || !form.displayName.trim()
    || (!form.id && !form.apiKey.trim())
    || (selectedProvider.customBaseUrl && !form.baseUrl.trim())
    || (selectedProvider.requiresManualModelId && !form.manualModelId.trim());

  const closeDialog = (force = false): void => {
    if (!force && busyAction === 'save') return;
    setIsDialogOpen(false);
    setDialogError('');
    setShowApiKey(false);
    setForm(emptyForm(snapshot?.providers));
  };

  const openAddDialog = (): void => {
    setForm(emptyForm(snapshot?.providers));
    setDialogError('');
    setError('');
    setMessage('');
    setShowApiKey(false);
    setIsDialogOpen(true);
  };

  const openEditDialog = (configuration: ModelConfigurationSummary): void => {
    const provider = snapshot?.providers.find(
      (item) => item.id === configuration.providerId,
    );
    setForm({
      apiKey: '',
      baseUrl: configuration.baseUrl ?? provider?.baseUrl ?? '',
      displayName: configuration.displayName,
      expectedWriteVersion: configuration.writeVersion,
      id: configuration.id,
      manualModelId: configuration.manualModelId ?? '',
      providerId: configuration.providerId,
    });
    setDialogError('');
    setError('');
    setMessage('');
    setShowApiKey(false);
    setIsDialogOpen(true);
  };

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDialog();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusableElements = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector),
    );
    const first = focusableElements[0];
    const last = focusableElements[focusableElements.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const handleOverlayMouseDown = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.currentTarget === event.target) closeDialog();
  };

  const handleSave = async (): Promise<void> => {
    if (!selectedProvider || saveDisabled) return;
    setBusyAction('save');
    setDialogError('');
    setError('');
    setMessage('');
    const result = await window.materialApi.models.saveConfiguration({
      apiKey: form.apiKey || undefined,
      baseUrl: selectedProvider.customBaseUrl ? form.baseUrl.trim() : undefined,
      displayName: form.displayName.trim(),
      expectedWriteVersion: form.expectedWriteVersion ?? undefined,
      id: form.id ?? undefined,
      manualModelId: selectedProvider.requiresManualModelId
        ? form.manualModelId.trim()
        : undefined,
      providerId: form.providerId,
    });
    if (!result.ok) {
      setBusyAction(null);
      setDialogError(result.error.message);
      return;
    }
    const refreshResult = await window.materialApi.models.refreshModels(result.data.id);
    closeDialog(true);
    const loaded = await load();
    setBusyAction(null);
    onChanged();
    if (!refreshResult.ok) {
      setError(
        `配置已安全保存，但 /models 验证失败：${refreshResult.error.message}。`
        + '可编辑配置后重试，或使用“刷新模型”。',
      );
    } else if (loaded) {
      setMessage(
        `已安全保存，并通过 /models 获取 ${refreshResult.data.availableModels.length} 个可用模型`,
      );
    }
  };

  const handleRefresh = async (id: string): Promise<void> => {
    setBusyAction(`refresh:${id}`);
    setError('');
    setMessage('');
    const result = await window.materialApi.models.refreshModels(id);
    const loaded = await load();
    setBusyAction(null);
    onChanged();
    if (!result.ok) {
      setError(`/models 验证失败：${result.error.message}`);
    } else if (loaded) {
      setMessage(`连接正常，已刷新 ${result.data.availableModels.length} 个可用模型`);
    }
  };

  const handleRemove = async (configuration: ModelConfigurationSummary): Promise<void> => {
    if (!window.confirm(`删除模型配置“${configuration.displayName}”？保存的 API Key 将一并删除。`)) {
      return;
    }
    setBusyAction(`remove:${configuration.id}`);
    setError('');
    setMessage('');
    const result = await window.materialApi.models.removeConfiguration(
      configuration.id,
      configuration.writeVersion,
    );
    if (!result.ok) {
      setBusyAction(null);
      setError(result.error.message);
      return;
    }
    const loaded = await load();
    setBusyAction(null);
    onChanged();
    if (loaded) setMessage('模型配置和对应凭据已删除');
  };

  const handleTestModel = async (
    configuration: ModelConfigurationSummary,
  ): Promise<void> => {
    const provider = snapshot?.providers.find(
      (item) => item.id === configuration.providerId,
    );
    if (
      !provider
      || configuration.connectionStatus !== 'ready'
      || !configuration.selectedModelId
    ) {
      return;
    }
    const confirmed = window.confirm(
      `将使用配置“${configuration.displayName}”和模型“${configuration.selectedModelId}”`
      + `向 ${provider.capabilities.dataDestination} 发送固定测试文本（仅要求模型回复 OK），`
      + '不会发送用户素材，但供应商可能收取少量调用费用。是否继续？',
    );
    if (!confirmed) return;
    setBusyAction(`test:${configuration.id}`);
    setError('');
    setMessage('');
    const result = await window.materialApi.models.testModel(
      configuration.id,
      configuration.selectedModelId,
    );
    setBusyAction(null);
    if (!result.ok) {
      setError(`测试调用失败：${result.error.message}`);
      return;
    }
    const returnedModel = result.data.returnedModelId === result.data.requestedModelId
      ? ''
      : `；供应商报告实际模型 ${result.data.returnedModelId}，请核对是否为别名或版本快照`;
    setMessage(
      `测试调用成功：${configuration.providerName} / 请求模型 `
      + `${result.data.requestedModelId}${returnedModel}；耗时 ${result.data.durationMs} 毫秒`,
    );
  };

  const handleDefaultModel = async (
    configuration: ModelConfigurationSummary,
    selectedModelId: string,
  ): Promise<void> => {
    setBusyAction(`select:${configuration.id}`);
    setError('');
    setMessage('');
    const result = await window.materialApi.models.saveConfiguration({
      displayName: configuration.displayName,
      expectedWriteVersion: configuration.writeVersion,
      id: configuration.id,
      providerId: configuration.providerId,
      selectedModelId,
    });
    if (!result.ok) {
      await load();
      setBusyAction(null);
      setError(result.error.message);
      onChanged();
      return;
    }
    const loaded = await load();
    setBusyAction(null);
    onChanged();
    if (loaded) setMessage('默认模型已更新');
  };

  const retryLoad = (): void => {
    setError('');
    setMessage('');
    void load();
  };

  return (
    <main className="page-shell model-settings-page">
      <header className="page-header model-settings-header">
        <div>
          <span className="eyebrow">BYOK · 用户自有 Key</span>
          <h1>模型管理</h1>
          <p>添加并管理模型配置；每次分析仍由你明确选择，不会静默切换。</p>
        </div>
        <div className="model-settings-header-actions">
          <Tag
            theme={secureStorageReady ? 'success' : 'danger'}
            variant="light"
          >
            {snapshot?.secureStorage.message ?? '正在检查系统安全存储'}
          </Tag>
          <Button
            disabled={loading || !snapshot?.providers.length || anyActionBusy}
            onClick={openAddDialog}
            theme="primary"
          >
            ＋ 添加模型
          </Button>
        </div>
      </header>

      <div className="model-validation-boundary">
        <strong>验证边界</strong>
        <span>
          保存和“刷新模型”只请求供应商的 /models；只有明确点击“测试调用”并确认后，
          才发送固定测试文本且可能产生少量费用。测试不会发送用户素材、生成分析或切换模型。
        </span>
      </div>

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

      <section className="model-config-list" aria-labelledby="saved-models-heading">
        <div className="settings-section-heading">
          <div>
            <h2 id="saved-models-heading">已保存模型</h2>
            <p>页面只显示配置摘要，API Key 不会从安全存储回传。</p>
          </div>
          <Tag variant="light">{snapshot?.configurations.length ?? 0} 个配置</Tag>
        </div>

        {loading && !snapshot ? (
          <div className="model-settings-empty" role="status">
            <span className="model-loading-indicator" aria-hidden="true" />
            <strong>正在读取模型配置</strong>
            <span>请稍候…</span>
          </div>
        ) : !snapshot ? (
          <div className="model-settings-empty">
            <strong>模型配置读取失败</strong>
            <span>请检查本地服务状态后重试。</span>
            <Button onClick={retryLoad} size="small" variant="outline">重新加载</Button>
          </div>
        ) : snapshot.configurations.length === 0 ? (
          <div className="model-settings-empty">
            <strong>还没有模型配置</strong>
            <span>添加用户自有 API Key，通过 /models 验证后即可用于分析。</span>
            <Button
              disabled={!snapshot.providers.length}
              onClick={openAddDialog}
              size="small"
              theme="primary"
            >
              添加第一个模型
            </Button>
          </div>
        ) : (
          <div className="model-config-cards">
            {snapshot.configurations.map((configuration) => {
              const providerAvailable = snapshot.providers.some(
                (provider) => provider.id === configuration.providerId,
              );
              const configurationBusy = busyAction?.endsWith(`:${configuration.id}`) ?? false;
              return (
                <article
                  aria-busy={configurationBusy}
                  className="model-config-card"
                  key={configuration.id}
                >
                  <div className="model-config-card-header">
                    <div>
                      <strong>{configuration.displayName}</strong>
                      <span>{configuration.providerName}</span>
                    </div>
                    <Tag
                      theme={!providerAvailable
                        ? 'danger'
                        : configuration.connectionStatus === 'ready'
                          ? 'success'
                          : configuration.connectionStatus === 'error'
                            ? 'danger'
                            : 'warning'}
                      variant="light"
                    >
                      {statusLabel(configuration, providerAvailable)}
                    </Tag>
                  </div>
                  <div className="model-config-meta">
                    <span>API Key：已由系统安全存储保护</span>
                    {configuration.baseUrl ? (
                      <span title={configuration.baseUrl}>API 地址：{configuration.baseUrl}</span>
                    ) : null}
                    {configuration.manualModelId ? (
                      <span title={configuration.manualModelId}>
                        模型 ID：{configuration.manualModelId}
                      </span>
                    ) : null}
                    <span>
                      {configuration.lastCheckedAt
                        ? `最近检查：${new Date(configuration.lastCheckedAt).toLocaleString()}`
                        : '尚未进行联网检查'}
                    </span>
                  </div>
                  <label className="form-field" htmlFor={`default-model-${configuration.id}`}>
                    <span className="field-label">默认模型</span>
                    <select
                      disabled={
                        configuration.availableModels.length === 0
                        || !providerAvailable
                        || configuration.connectionStatus !== 'ready'
                        || anyActionBusy
                      }
                      id={`default-model-${configuration.id}`}
                      onChange={(event) => void handleDefaultModel(
                        configuration,
                        event.target.value,
                      )}
                      value={configuration.selectedModelId ?? ''}
                    >
                      <option
                        disabled={configuration.availableModels.length > 0}
                        value=""
                      >
                        {configuration.availableModels.length ? '请选择默认模型' : '尚无可用模型'}
                      </option>
                      {configuration.availableModels.map((model) => (
                        <option key={model.id} value={model.id}>{model.id}</option>
                      ))}
                    </select>
                  </label>
                  <div className="model-config-actions">
                    <Button
                      disabled={!providerAvailable || !secureStorageReady || anyActionBusy}
                      loading={busyAction === `refresh:${configuration.id}`}
                      onClick={() => void handleRefresh(configuration.id)}
                      size="small"
                      variant="outline"
                    >
                      刷新模型
                    </Button>
                    <Button
                      disabled={
                        !providerAvailable
                        || !secureStorageReady
                        || configuration.connectionStatus !== 'ready'
                        || !configuration.selectedModelId
                        || anyActionBusy
                      }
                      loading={busyAction === `test:${configuration.id}`}
                      onClick={() => void handleTestModel(configuration)}
                      size="small"
                      variant="outline"
                    >
                      测试调用
                    </Button>
                    <Button
                      disabled={!providerAvailable || anyActionBusy}
                      onClick={() => openEditDialog(configuration)}
                      size="small"
                      variant="text"
                    >
                      编辑
                    </Button>
                    <Button
                      disabled={anyActionBusy && busyAction !== `remove:${configuration.id}`}
                      loading={busyAction === `remove:${configuration.id}`}
                      onClick={() => void handleRemove(configuration)}
                      size="small"
                      theme="danger"
                      variant="text"
                    >
                      删除
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {isDialogOpen ? (
        <div className="model-dialog-backdrop" onMouseDown={handleOverlayMouseDown}>
          <div
            aria-describedby="model-dialog-description"
            aria-labelledby="model-dialog-title"
            aria-modal="true"
            className="model-dialog"
            onKeyDown={handleDialogKeyDown}
            ref={dialogRef}
            role="dialog"
          >
            <div className="model-dialog-header">
              <div>
                <h2 id="model-dialog-title">{form.id ? '编辑模型' : '添加模型'}</h2>
                <p id="model-dialog-description">支持当前列出的 OpenAI 及兼容接入方式。</p>
              </div>
              <button
                aria-label="关闭模型配置弹窗"
                className="model-dialog-close"
                disabled={busyAction === 'save'}
                onClick={() => closeDialog()}
                type="button"
              >
                ×
              </button>
            </div>

            <form
              onSubmit={(event) => {
                event.preventDefault();
                void handleSave();
              }}
            >
              {dialogError ? (
                <div className="settings-message is-error" role="alert">{dialogError}</div>
              ) : null}

              <div className="model-form-fields">
                <label className="form-field" htmlFor="model-provider">
                  <span className="field-label">供应商</span>
                  <select
                    disabled={Boolean(form.id) || busyAction === 'save'}
                    id="model-provider"
                    onChange={(event) => {
                      const provider = snapshot?.providers.find(
                        (item) => item.id === event.target.value,
                      );
                      setForm((current) => ({
                        ...current,
                        baseUrl: provider?.baseUrl ?? '',
                        manualModelId: '',
                        providerId: event.target.value,
                      }));
                      setDialogError('');
                    }}
                    required
                    value={form.providerId}
                  >
                    {(snapshot?.providers ?? []).map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.displayName}
                      </option>
                    ))}
                  </select>
                </label>

                {selectedProvider?.customBaseUrl ? (
                  <label className="form-field" htmlFor="model-base-url">
                    <span className="field-label">API 地址</span>
                    <input
                      autoComplete="url"
                      disabled={busyAction === 'save'}
                      id="model-base-url"
                      maxLength={2_048}
                      onChange={(event) => setForm((current) => ({
                        ...current,
                        baseUrl: event.target.value,
                      }))}
                      placeholder="https://api.example.com/v1"
                      required
                      spellCheck={false}
                      type="url"
                      value={form.baseUrl}
                    />
                    <small>可填写 API Base URL 或完整的 /chat/completions 地址。</small>
                  </label>
                ) : null}

                <label className="form-field" htmlFor="model-display-name">
                  <span className="field-label">配置名称</span>
                  <input
                    disabled={busyAction === 'save'}
                    id="model-display-name"
                    maxLength={80}
                    onChange={(event) => setForm((current) => ({
                      ...current,
                      displayName: event.target.value,
                    }))}
                    placeholder="例如：内容分析模型"
                    required
                    value={form.displayName}
                  />
                </label>

                <label className="form-field" htmlFor="model-api-key">
                  <span className="field-label">API Key</span>
                  <span className="model-password-field">
                    <input
                      autoComplete="new-password"
                      disabled={busyAction === 'save'}
                      id="model-api-key"
                      maxLength={512}
                      onChange={(event) => setForm((current) => ({
                        ...current,
                        apiKey: event.target.value,
                      }))}
                      placeholder={form.id ? '留空则保留原 API Key' : '输入用户自有 API Key'}
                      required={!form.id}
                      type={showApiKey ? 'text' : 'password'}
                      value={form.apiKey}
                    />
                    <button
                      aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}
                      disabled={busyAction === 'save'}
                      onClick={() => setShowApiKey((current) => !current)}
                      type="button"
                    >
                      {showApiKey ? '隐藏' : '显示'}
                    </button>
                  </span>
                  <small>
                    {form.id
                      ? '页面不会回显已保存的 Key；留空即保持原凭据。'
                      : 'Key 只在主进程短暂使用，并由系统安全存储加密。'}
                  </small>
                </label>

                {selectedProvider?.requiresManualModelId ? (
                  <label className="form-field" htmlFor="model-manual-id">
                    <span className="field-label">模型 ID</span>
                    <input
                      disabled={busyAction === 'save'}
                      id="model-manual-id"
                      maxLength={128}
                      onChange={(event) => setForm((current) => ({
                        ...current,
                        manualModelId: event.target.value,
                      }))}
                      placeholder="例如：my-model-name"
                      required
                      spellCheck={false}
                      value={form.manualModelId}
                    />
                    <small>填写供应商用于 API 调用的准确模型标识。</small>
                  </label>
                ) : null}
              </div>

              <div className="model-form-notice">
                <strong>保存与调用边界</strong>
                <span>
                  保存后只请求 /models 验证连接，不会发起模型生成或产生测试调用费用。
                  只有之后明确点击“测试调用”并再次确认，才会发送固定测试文本。
                  {selectedProvider
                    ? ` 后续明确运行分析时，文本与结构化证据会发送至 ${selectedProvider.capabilities.dataDestination}；不会直接上传原始视频或图片。`
                    : ''}
                </span>
              </div>

              {!secureStorageReady ? (
                <div className="model-secure-storage-warning" role="alert">
                  {snapshot?.secureStorage.message ?? '系统安全存储当前不可用，暂时无法保存 API Key。'}
                </div>
              ) : null}

              <div className="model-dialog-actions">
                <Button
                  disabled={busyAction === 'save'}
                  onClick={() => closeDialog()}
                  variant="outline"
                >
                  取消
                </Button>
                <Button
                  disabled={saveDisabled}
                  loading={busyAction === 'save'}
                  theme="primary"
                  type="submit"
                >
                  保存并验证
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </main>
  );
};
