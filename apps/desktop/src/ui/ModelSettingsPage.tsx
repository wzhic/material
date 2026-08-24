import React, { useCallback, useEffect, useState } from 'react';
import { Button, Input, Tag } from 'tdesign-react';

import {
  ModelConfigurationSummary,
  ModelProviderInfo,
  ModelSettingsSnapshot,
} from '../model/types';

interface ModelSettingsPageProps {
  onChanged: () => void;
}

interface ConfigurationForm {
  id: string | null;
  providerId: string;
  displayName: string;
  apiKey: string;
  expectedWriteVersion: number | null;
}

const emptyForm = (providers: ModelProviderInfo[] = []): ConfigurationForm => ({
  apiKey: '',
  displayName: '',
  expectedWriteVersion: null,
  id: null,
  providerId: providers[0]?.id ?? '',
});

const statusLabel = (configuration: ModelConfigurationSummary): string => {
  if (configuration.connectionStatus === 'ready') return '连接正常';
  if (configuration.connectionStatus === 'error') return '连接失败';
  return '尚未验证';
};

export const ModelSettingsPage = ({
  onChanged,
}: ModelSettingsPageProps): React.JSX.Element => {
  const [snapshot, setSnapshot] = useState<ModelSettingsSnapshot | null>(null);
  const [form, setForm] = useState<ConfigurationForm>(emptyForm());
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async (): Promise<void> => {
    setError('');
    const result = await window.materialApi.models.getSettings();
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setSnapshot(result.data);
    setForm((current) => current.providerId
      ? current
      : { ...current, providerId: result.data.providers[0]?.id ?? '' });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const resetForm = (): void => {
    setForm(emptyForm(snapshot?.providers));
    setError('');
  };

  const handleSave = async (): Promise<void> => {
    setBusyAction('save');
    setError('');
    setMessage('');
    const result = await window.materialApi.models.saveConfiguration({
      apiKey: form.apiKey || undefined,
      displayName: form.displayName,
      expectedWriteVersion: form.expectedWriteVersion ?? undefined,
      id: form.id ?? undefined,
      providerId: form.providerId,
    });
    if (!result.ok) {
      setBusyAction(null);
      setError(result.error.message);
      return;
    }
    const refresh = await window.materialApi.models.refreshModels(result.data.id);
    setBusyAction(null);
    setForm(emptyForm(snapshot?.providers));
    if (refresh.ok) {
      setMessage(`已安全保存并获取 ${refresh.data.availableModels.length} 个可用模型`);
    } else {
      setError(`配置已安全保存；${refresh.error.message}`);
    }
    await load();
    onChanged();
  };

  const handleRefresh = async (id: string): Promise<void> => {
    setBusyAction(`refresh:${id}`);
    setError('');
    setMessage('');
    const result = await window.materialApi.models.refreshModels(id);
    setBusyAction(null);
    if (!result.ok) {
      setError(result.error.message);
    } else {
      setMessage(`连接正常，已刷新 ${result.data.availableModels.length} 个模型`);
    }
    await load();
    onChanged();
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
    setBusyAction(null);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    if (form.id === configuration.id) resetForm();
    setMessage('模型配置和对应凭据已删除');
    await load();
    onChanged();
  };

  const handleDefaultModel = async (
    configuration: ModelConfigurationSummary,
    selectedModelId: string,
  ): Promise<void> => {
    setBusyAction(`select:${configuration.id}`);
    const result = await window.materialApi.models.saveConfiguration({
      displayName: configuration.displayName,
      expectedWriteVersion: configuration.writeVersion,
      id: configuration.id,
      providerId: configuration.providerId,
      selectedModelId,
    });
    setBusyAction(null);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    await load();
    onChanged();
  };

  const secureStorageReady = snapshot?.secureStorage.available ?? false;
  const selectedProvider = snapshot?.providers.find(
    (provider) => provider.id === form.providerId,
  );

  return (
    <main className="page-shell model-settings-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">BYOK · 用户自有 Key</span>
          <h1>模型与工具设置</h1>
          <p>配置模型供应商、验证连接，并为每次分析显式选择模型。</p>
        </div>
        <Tag
          theme={secureStorageReady ? 'success' : 'danger'}
          variant="light"
        >
          {snapshot?.secureStorage.message ?? '正在检查系统安全存储'}
        </Tag>
      </header>

      {error ? <div className="settings-message is-error" role="alert">{error}</div> : null}
      {message ? <div className="settings-message is-success" role="status">{message}</div> : null}

      <section className="model-settings-grid">
        <div className="model-config-list">
          <div className="settings-section-heading">
            <div>
              <h2>已配置模型</h2>
              <p>列表只显示配置摘要，API Key 不会返回页面。</p>
            </div>
            <Tag variant="light">{snapshot?.configurations.length ?? 0} 个配置</Tag>
          </div>

          {!snapshot ? (
            <div className="model-settings-empty">正在读取本地模型配置…</div>
          ) : snapshot.configurations.length === 0 ? (
            <div className="model-settings-empty">
              <strong>还没有模型配置</strong>
              <span>在右侧填写用户自有 API Key，保存后即可验证连接。</span>
            </div>
          ) : (
            snapshot.configurations.map((configuration) => (
              <article className="model-config-card" key={configuration.id}>
                <div className="model-config-card-header">
                  <div>
                    <strong>{configuration.displayName}</strong>
                    <span>{configuration.providerName}</span>
                  </div>
                  <Tag
                    theme={configuration.connectionStatus === 'ready'
                      ? 'success'
                      : configuration.connectionStatus === 'error'
                        ? 'danger'
                        : 'warning'}
                    variant="light"
                  >
                    {statusLabel(configuration)}
                  </Tag>
                </div>
                <div className="model-config-meta">
                  <span>凭据：已由系统安全存储保护</span>
                  <span>
                    {configuration.lastCheckedAt
                      ? `最近检查：${new Date(configuration.lastCheckedAt).toLocaleString()}`
                      : '尚未进行联网检查'}
                  </span>
                </div>
                <label className="form-field">
                  <span className="field-label">默认模型</span>
                  <select
                    disabled={
                      configuration.availableModels.length === 0
                      || busyAction === `select:${configuration.id}`
                    }
                    onChange={(event) => void handleDefaultModel(
                      configuration,
                      event.target.value,
                    )}
                    value={configuration.selectedModelId ?? ''}
                  >
                    <option value="">尚无可用模型</option>
                    {configuration.availableModels.map((model) => (
                      <option key={model.id} value={model.id}>{model.id}</option>
                    ))}
                  </select>
                </label>
                <div className="model-config-actions">
                  <Button
                    loading={busyAction === `refresh:${configuration.id}`}
                    onClick={() => void handleRefresh(configuration.id)}
                    size="small"
                    variant="outline"
                  >
                    测试并刷新模型
                  </Button>
                  <Button
                    onClick={() => {
                      setForm({
                        apiKey: '',
                        displayName: configuration.displayName,
                        expectedWriteVersion: configuration.writeVersion,
                        id: configuration.id,
                        providerId: configuration.providerId,
                      });
                      setError('');
                      setMessage('');
                    }}
                    size="small"
                    variant="text"
                  >
                    编辑
                  </Button>
                  <Button
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
            ))
          )}
        </div>

        <aside className="model-config-form">
          <div className="settings-section-heading">
            <div>
              <h2>{form.id ? '编辑配置' : '添加模型配置'}</h2>
              <p>{form.id ? 'API Key 留空即保持原凭据。' : '当前先支持 DeepSeek。'}</p>
            </div>
          </div>
          <div className="model-form-fields">
            <label className="form-field">
              <span className="field-label">供应商</span>
              <select
                disabled={Boolean(form.id)}
                onChange={(event) => setForm((current) => ({
                  ...current,
                  providerId: event.target.value,
                }))}
                value={form.providerId}
              >
                {(snapshot?.providers ?? []).map((provider) => (
                  <option key={provider.id} value={provider.id}>{provider.displayName}</option>
                ))}
              </select>
            </label>
            <label className="form-field">
              <span className="field-label">配置名称</span>
              <Input
                maxlength={80}
                onChange={(value) => setForm((current) => ({
                  ...current,
                  displayName: value,
                }))}
                placeholder="例如：我的 DeepSeek"
                value={form.displayName}
              />
            </label>
            <label className="form-field">
              <span className="field-label">API Key</span>
              <input
                autoComplete="new-password"
                onChange={(event) => setForm((current) => ({
                  ...current,
                  apiKey: event.target.value,
                }))}
                placeholder={form.id ? '留空保持原 Key' : '输入用户自有 Key'}
                type="password"
                value={form.apiKey}
              />
              <small>只在主进程短暂使用；持久化内容由系统安全存储加密。</small>
            </label>
          </div>
          <div className="model-form-notice">
            <strong>保存与调用边界</strong>
            <span>
              保存后会联网读取模型列表；不会自动调用模型、切换模型或产生分析报告。
              {selectedProvider
                ? ` 当前适配只向 ${selectedProvider.capabilities.dataDestination} 发送文本和后续明确组装的结构化证据，不直接上传视频或图片。`
                : ''}
            </span>
          </div>
          <Button
            block
            disabled={
              !secureStorageReady
              || !form.displayName.trim()
              || !form.providerId
              || (!form.id && !form.apiKey)
            }
            loading={busyAction === 'save'}
            onClick={() => void handleSave()}
            theme="primary"
          >
            保存并验证
          </Button>
          {form.id ? (
            <Button block onClick={resetForm} variant="text">取消编辑</Button>
          ) : null}
        </aside>
      </section>
    </main>
  );
};
