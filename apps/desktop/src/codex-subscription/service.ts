import { lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  CodexAppServerClient,
  CodexAppServerNotification,
  CodexAppServerRequest,
  CodexAppServerRequestError,
  CodexAppServerRuntimeClosedEvent,
  JsonObject,
} from './client';
import { CodexSubscriptionError, toPublicCodexError } from './errors';
import {
  CODEX_DEVICE_VERIFICATION_URL,
  CodexBrowserLoginStarted,
  CodexConnectivityTestResult,
  CodexDeviceLoginStarted,
  CodexLoginCompletedEvent,
  CodexModelSummary,
  CodexRateLimitBucket,
  CodexRateLimitsSummary,
  CodexRateLimitWindow,
  CodexSubscriptionState,
} from './types';

interface CodexAppServerPort {
  onNotification(
    listener: (notification: CodexAppServerNotification) => void,
  ): () => void;
  onServerRequest(listener: (request: CodexAppServerRequest) => void): () => void;
  onRuntimeClosed(
    listener: (event: CodexAppServerRuntimeClosedEvent) => void,
  ): () => void;
  getGeneration(): number | null;
  invalidateGeneration(
    generation: number,
    code?: CodexAppServerRuntimeClosedEvent['code'],
  ): boolean;
  request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  requestIfRunning<T>(
    generation: number,
    method: string,
    params?: unknown,
    timeoutMs?: number,
  ): Promise<T>;
  start(): Promise<void>;
  stop(): void;
}

export interface CodexSubscriptionServiceOptions {
  client: CodexAppServerPort | null;
  clientFactory?: () => Promise<CodexAppServerPort>;
  loginTimeoutMs?: number;
  now?: () => Date;
  openExternal: (url: string) => Promise<void>;
  probeTimeoutMs?: number;
  settingsPath: string;
}

interface PendingLoginCompletion {
  error: unknown;
  loginId: string;
  success: boolean;
}

interface ProbeContext {
  abortRequested: boolean;
  finalText: string | null;
  generation: number | null;
  interrupted: boolean;
  requestedModelId: string;
  returnedModelId: string;
  settled: boolean;
  startedAt: number;
  threadId: string | null;
  turnId: string | null;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface AccountReadResponse {
  account?: unknown;
  requiresOpenaiAuth?: unknown;
}

interface ModelListResponse {
  data?: unknown;
  nextCursor?: unknown;
}

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const LOGIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_MODEL_PAGES = 20;
const MAX_MODELS = 200;
const MAX_SETTINGS_BYTES = 4096;
const DEFAULT_PROBE_TIMEOUT_MS = 60_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60_000;
const CONTROL_REQUEST_TIMEOUT_MS = 30_000;

const PROBE_PROMPT = 'Reply with exactly this JSON object: {"result":"OK"}. Do not use tools.';
const PROBE_OUTPUT_SCHEMA = {
  additionalProperties: false,
  properties: { result: { const: 'OK', type: 'string' } },
  required: ['result'],
  type: 'object',
};

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const safeString = (value: unknown, maxLength = 256): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= maxLength
    ? value
    : null;

const safeNullableString = (value: unknown, maxLength = 256): string | null =>
  value === null ? null : safeString(value, maxLength);

const validIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && MODEL_ID_PATTERN.test(value);

const cloneState = (state: CodexSubscriptionState): CodexSubscriptionState => ({
  ...state,
  lastError: state.lastError ? { ...state.lastError } : null,
  models: state.models.map((model) => ({
    ...model,
    inputModalities: [...model.inputModalities],
    supportedReasoningEfforts: model.supportedReasoningEfforts.map((effort) => ({
      ...effort,
    })),
  })),
  rateLimits: state.rateLimits ? {
    ...state.rateLimits,
    buckets: state.rateLimits.buckets.map((bucket) => ({
      ...bucket,
      primary: bucket.primary ? { ...bucket.primary } : null,
      secondary: bucket.secondary ? { ...bucket.secondary } : null,
    })),
  } : null,
});

export const maskCodexAccountEmail = (email: string | null): string => {
  if (!email || email.length > 320) return 'ChatGPT 订阅账户';
  const separator = email.lastIndexOf('@');
  if (separator <= 0 || separator === email.length - 1) return 'ChatGPT 订阅账户';
  const local = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  const domainParts = domain.split('.');
  const host = domainParts.shift() ?? '';
  const suffix = domainParts.length > 0 ? `.${domainParts.join('.')}` : '';
  return `${local.slice(0, 1)}***@${host.slice(0, 1)}***${suffix}`;
};

const unixSecondsToIso = (value: unknown): string | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const mapRateLimitWindow = (value: unknown): CodexRateLimitWindow | null => {
  if (!isRecord(value)
    || typeof value.usedPercent !== 'number'
    || !Number.isFinite(value.usedPercent)) return null;
  return {
    resetsAt: unixSecondsToIso(value.resetsAt),
    usedPercent: Math.min(100, Math.max(0, value.usedPercent)),
    windowDurationMins: typeof value.windowDurationMins === 'number'
      && Number.isFinite(value.windowDurationMins)
      && value.windowDurationMins >= 0
      ? value.windowDurationMins
      : null,
  };
};

const mapRateLimitBucket = (
  value: unknown,
  fallbackLimitId = 'codex',
): CodexRateLimitBucket | null => {
  if (!isRecord(value)) return null;
  const limitId = safeString(value.limitId) ?? fallbackLimitId;
  if (!validIdentifier(limitId)) return null;
  return {
    limitId,
    limitName: safeNullableString(value.limitName),
    planType: safeNullableString(value.planType),
    primary: mapRateLimitWindow(value.primary),
    rateLimitReachedType: safeNullableString(value.rateLimitReachedType),
    secondary: mapRateLimitWindow(value.secondary),
  };
};

const isLimited = (limits: CodexRateLimitsSummary | null): boolean =>
  limits?.buckets.some((bucket) =>
    bucket.rateLimitReachedType !== null
    || (bucket.primary?.usedPercent ?? 0) >= 100
    || (bucket.secondary?.usedPercent ?? 0) >= 100) ?? false;

const codexErrorType = (value: unknown): string | null => {
  if (value === 'usageLimitExceeded' || value === 'unauthorized') return value;
  if (isRecord(value)
    && (value.type === 'usageLimitExceeded' || value.type === 'unauthorized')) {
    return value.type;
  }
  return null;
};

const mapModel = (value: unknown): CodexModelSummary | null => {
  if (!isRecord(value)) return null;
  const id = safeString(value.id, 128);
  const displayName = safeString(value.displayName, 160);
  if (!id || !displayName || !validIdentifier(id) || value.hidden === true) return null;
  const efforts = Array.isArray(value.supportedReasoningEfforts)
    ? value.supportedReasoningEfforts.flatMap((effort) => {
      if (!isRecord(effort)) return [];
      const reasoningEffort = safeString(effort.reasoningEffort, 64);
      if (!reasoningEffort) return [];
      return [{
        description: safeNullableString(effort.description, 500),
        reasoningEffort,
      }];
    })
    : [];
  const modalities = Array.isArray(value.inputModalities)
    ? value.inputModalities.filter((entry): entry is string =>
      typeof entry === 'string' && entry.length > 0 && entry.length <= 32)
    : [];
  if (!modalities.includes('text')) return null;
  return {
    defaultReasoningEffort: safeNullableString(value.defaultReasoningEffort, 64),
    displayName,
    id,
    inputModalities: modalities,
    isDefault: value.isDefault === true,
    supportedReasoningEfforts: efforts,
  };
};

const isOfficialBrowserLoginUrl = (candidate: string): boolean => {
  try {
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase();
    const officialHost = hostname === 'chatgpt.com'
      || hostname.endsWith('.chatgpt.com')
      || hostname === 'auth.openai.com';
    return url.protocol === 'https:'
      && officialHost
      && url.username === ''
      && url.password === '';
  } catch {
    return false;
  }
};

const isExactDeviceVerificationUrl = (candidate: string): boolean => {
  try {
    const url = new URL(candidate);
    return url.href === CODEX_DEVICE_VERIFICATION_URL;
  } catch {
    return false;
  }
};

const allowedProbeItem = (item: unknown): boolean => {
  if (!isRecord(item) || typeof item.type !== 'string') return false;
  return item.type === 'userMessage'
    || item.type === 'agentMessage'
    || item.type === 'reasoning';
};

const notificationBelongsToProbe = (
  probe: ProbeContext,
  params: unknown,
): boolean => {
  if (!isRecord(params)) return false;
  if (probe.threadId !== null && params.threadId !== probe.threadId) return false;
  if (probe.turnId !== null && 'turnId' in params && params.turnId !== probe.turnId) {
    return false;
  }
  return true;
};

const isSidecarTrustFailure = (error: unknown): boolean =>
  error instanceof CodexSubscriptionError
  && (error.code === 'PROTOCOL_ERROR' || error.code === 'SECURITY_VIOLATION');

export class CodexSubscriptionService {
  private client: CodexAppServerPort | null;

  private readonly stateListeners = new Set<(state: CodexSubscriptionState) => void>();

  private readonly loginListeners = new Set<(event: CodexLoginCompletedEvent) => void>();

  private readonly rateLimitListeners = new Set<(limits: CodexRateLimitsSummary) => void>();

  private readonly now: () => Date;

  private readonly probeTimeoutMs: number;

  private readonly loginTimeoutMs: number;

  private state: CodexSubscriptionState;

  private accountEpoch = 0;

  private initializePromise: Promise<void> | null = null;

  private recoveryPromise: Promise<void> | null = null;

  private loginStarting = false;

  private activeLoginId: string | null = null;

  private activeLoginGeneration: number | null = null;

  private loginTimeout: ReturnType<typeof setTimeout> | null = null;

  private loginHydrationPromise: Promise<void> | null = null;

  private loginReconciliationPromise: Promise<void> | null = null;

  private readonly settledLoginIds = new Set<string>();

  private readonly earlyLoginCompletions = new Map<string, PendingLoginCompletion>();

  private activeProbe: ProbeContext | null = null;

  private readonly interruptibleProbes = new Map<string, ProbeContext>();

  private readonly unsubscribeClientEvents: Array<() => void> = [];

  private settingsWriteQueue: Promise<void> = Promise.resolve();

  private settingsWriteCounter = 0;

  constructor(private readonly options: CodexSubscriptionServiceOptions) {
    this.client = options.client;
    this.now = options.now ?? (() => new Date());
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.loginTimeoutMs = options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
    this.state = {
      accountLabel: null,
      lastError: null,
      models: [],
      pendingLoginId: null,
      planType: null,
      rateLimits: null,
      selectedModelId: null,
      status: this.client || options.clientFactory ? 'signedOut' : 'unavailable',
    };
    if (this.client) this.attachClientEvents(this.client);
  }

  onStateChanged(listener: (state: CodexSubscriptionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onLoginCompleted(listener: (event: CodexLoginCompletedEvent) => void): () => void {
    this.loginListeners.add(listener);
    return () => this.loginListeners.delete(listener);
  }

  onRateLimitsChanged(listener: (limits: CodexRateLimitsSummary) => void): () => void {
    this.rateLimitListeners.add(listener);
    return () => this.rateLimitListeners.delete(listener);
  }

  async getState(): Promise<CodexSubscriptionState> {
    await this.initialize();
    if (this.loginReconciliationPromise) {
      await this.loginReconciliationPromise.catch(() => undefined);
    }
    await this.settingsWriteQueue.catch(() => undefined);
    return cloneState(this.state);
  }

  async startBrowserLogin(): Promise<CodexBrowserLoginStarted> {
    await this.ensureOperational();
    this.assertNoActiveProbe();
    const loginEpoch = await this.beginLogin();
    const loginGeneration = this.client?.getGeneration() ?? null;
    if (loginGeneration === null) {
      const error = new CodexSubscriptionError('RUNTIME_UNAVAILABLE');
      this.failLoginStart(error, null);
      throw error;
    }
    let issuedLoginId: string | null = null;
    try {
      this.assertAccountEpoch(loginEpoch);
      const response = await this.clientRequest<unknown>(loginGeneration, 'account/login/start', {
        appBrand: 'chatgpt',
        type: 'chatgpt',
        useHostedLoginSuccessPage: true,
      });
      if (!isRecord(response)
        || response.type !== 'chatgpt'
        || !LOGIN_ID_PATTERN.test(String(response.loginId ?? ''))
        || typeof response.authUrl !== 'string'
        || !isOfficialBrowserLoginUrl(response.authUrl)) {
        this.throwSidecarTrustFailure(loginGeneration, 'SECURITY_VIOLATION');
      }
      const loginId = String(response.loginId);
      issuedLoginId = loginId;
      if (this.accountEpoch !== loginEpoch) {
        this.discardStaleLoginStart(loginId, loginGeneration);
        throw new CodexSubscriptionError('TEST_FAILED');
      }
      this.activateLogin(loginId, loginGeneration);
      await this.options.openExternal(response.authUrl);
      if (this.client?.getGeneration() !== loginGeneration) {
        throw new CodexSubscriptionError('RUNTIME_UNAVAILABLE');
      }
      this.applyEarlyLoginCompletion(loginId);
      return { loginId };
    } catch (error) {
      if (!issuedLoginId || !this.settledLoginIds.has(issuedLoginId)) {
        this.failLoginStart(error, loginGeneration);
      }
      throw this.normalized(error, 'LOGIN_FAILED');
    }
  }

  async startDeviceLogin(): Promise<CodexDeviceLoginStarted> {
    await this.ensureOperational();
    this.assertNoActiveProbe();
    const loginEpoch = await this.beginLogin();
    const loginGeneration = this.client?.getGeneration() ?? null;
    if (loginGeneration === null) {
      const error = new CodexSubscriptionError('RUNTIME_UNAVAILABLE');
      this.failLoginStart(error, null);
      throw error;
    }
    let issuedLoginId: string | null = null;
    try {
      this.assertAccountEpoch(loginEpoch);
      const response = await this.clientRequest<unknown>(loginGeneration, 'account/login/start', {
        type: 'chatgptDeviceCode',
      });
      if (!isRecord(response)
        || response.type !== 'chatgptDeviceCode'
        || !LOGIN_ID_PATTERN.test(String(response.loginId ?? ''))
        || typeof response.verificationUrl !== 'string'
        || !isExactDeviceVerificationUrl(response.verificationUrl)
        || typeof response.userCode !== 'string'
        || !/^[A-Z0-9-]{4,32}$/i.test(response.userCode)) {
        this.throwSidecarTrustFailure(loginGeneration, 'SECURITY_VIOLATION');
      }
      const loginId = String(response.loginId);
      issuedLoginId = loginId;
      if (this.accountEpoch !== loginEpoch) {
        this.discardStaleLoginStart(loginId, loginGeneration);
        throw new CodexSubscriptionError('TEST_FAILED');
      }
      this.activateLogin(loginId, loginGeneration);
      this.applyEarlyLoginCompletion(loginId);
      return {
        loginId,
        userCode: response.userCode,
        verificationUrl: CODEX_DEVICE_VERIFICATION_URL,
      };
    } catch (error) {
      if (!issuedLoginId || !this.settledLoginIds.has(issuedLoginId)) {
        this.failLoginStart(error, loginGeneration);
      }
      throw this.normalized(error, 'LOGIN_FAILED');
    }
  }

  async openDeviceVerificationPage(): Promise<null> {
    await this.ensureOperational();
    await this.options.openExternal(CODEX_DEVICE_VERIFICATION_URL);
    return null;
  }

  async cancelLogin(loginId: string): Promise<null> {
    await this.ensureOperational();
    this.assertNoActiveProbe();
    if (!LOGIN_ID_PATTERN.test(loginId) || loginId !== this.activeLoginId) {
      throw new CodexSubscriptionError('INVALID_INPUT');
    }
    const generation = this.requireCurrentGeneration();
    if (generation !== this.activeLoginGeneration) {
      throw new CodexSubscriptionError('RUNTIME_UNAVAILABLE');
    }
    const response = await this.clientRequest<unknown>(
      generation,
      'account/login/cancel',
      { loginId },
    );
    if (!isRecord(response) || (response.status !== 'canceled' && response.status !== 'notFound')) {
      this.throwSidecarTrustFailure(generation, 'PROTOCOL_ERROR');
    }
    await this.claimLoginOutcome(loginId, false, null);
    // Cancellation acknowledgement is not proof of the authoritative account state.
    await this.reconcileSettledLogin(generation);
    return null;
  }

  async refreshModels(): Promise<CodexModelSummary[]> {
    await this.ensureSignedIn();
    this.assertNoActiveProbe();
    const epoch = this.accountEpoch;
    const generation = this.requireCurrentGeneration();
    await this.refreshModelsInternal(epoch, generation);
    return cloneState(this.state).models;
  }

  async refreshAccount(): Promise<CodexSubscriptionState> {
    await this.ensureOperational();
    this.assertNoActiveProbe();
    if (this.loginStarting || this.activeLoginId || this.loginHydrationPromise) {
      throw new CodexSubscriptionError('LOGIN_IN_PROGRESS');
    }
    const epoch = this.accountEpoch;
    const generation = this.requireCurrentGeneration();
    try {
      await this.refreshAccountInternal(true, epoch, generation);
      return cloneState(this.state);
    } catch (error) {
      const normalized = error instanceof CodexSubscriptionError
        ? error
        : new CodexSubscriptionError('UNKNOWN');
      throw normalized;
    }
  }

  async selectModel(modelId: string | null): Promise<CodexSubscriptionState> {
    await this.ensureSignedIn();
    this.assertNoActiveProbe();
    if (modelId !== null
      && (!validIdentifier(modelId) || !this.state.models.some((model) => model.id === modelId))) {
      throw new CodexSubscriptionError('MODEL_UNAVAILABLE');
    }
    this.state.selectedModelId = modelId;
    await this.persistSelectedModel();
    this.emitState();
    return cloneState(this.state);
  }

  async getRateLimits(): Promise<CodexRateLimitsSummary | null> {
    await this.ensureSignedIn();
    this.assertNoActiveProbe();
    const epoch = this.accountEpoch;
    const generation = this.requireCurrentGeneration();
    await this.refreshRateLimitsInternal(epoch, generation);
    return cloneState(this.state).rateLimits;
  }

  async testSelectedModel(): Promise<CodexConnectivityTestResult> {
    await this.ensureSignedIn();
    if (this.activeProbe) throw new CodexSubscriptionError('TEST_FAILED');
    if (this.state.status === 'limited') {
      throw new CodexSubscriptionError('RATE_LIMITED');
    }
    if (this.state.status !== 'ready') {
      throw new CodexSubscriptionError('TEST_FAILED');
    }
    const modelId = this.state.selectedModelId;
    if (!modelId) throw new CodexSubscriptionError('NO_MODEL_SELECTED');
    if (!this.state.models.some((model) => model.id === modelId)) {
      throw new CodexSubscriptionError('MODEL_UNAVAILABLE');
    }
    const generation = this.client?.getGeneration() ?? null;
    if (generation === null) throw new CodexSubscriptionError('RUNTIME_UNAVAILABLE');
    const startedAt = Date.now();
    let terminalResolve: () => void = () => undefined;
    let terminalReject: (error: Error) => void = () => undefined;
    const terminalPromise = new Promise<void>((resolve, reject) => {
      terminalResolve = resolve;
      terminalReject = reject;
    });
    // A lifecycle notification may reject during preflight before the first race is installed.
    void terminalPromise.catch(() => undefined);
    const probe: ProbeContext = {
      abortRequested: false,
      finalText: null,
      generation,
      interrupted: false,
      reject: terminalReject,
      requestedModelId: modelId,
      resolve: terminalResolve,
      returnedModelId: modelId,
      settled: false,
      startedAt,
      threadId: null,
      turnId: null,
    };
    this.activeProbe = probe;
    let probeDirectory: string | null = null;
    const timeout = setTimeout(() => {
      this.rejectProbe(new CodexSubscriptionError('TEST_TIMEOUT'));
    }, this.probeTimeoutMs);
    timeout.unref?.();
    let turnRequestPending = false;

    try {
      await Promise.race([this.preflightProbe(probe, modelId), terminalPromise]);
      if (isLimited(this.state.rateLimits)) throw new CodexSubscriptionError('RATE_LIMITED');
      if (this.state.status !== 'ready') throw new CodexSubscriptionError('TEST_FAILED');
      if (this.state.selectedModelId !== modelId) {
        throw new CodexSubscriptionError('MODEL_UNAVAILABLE');
      }
      const directoryPromise = mkdtemp(path.join(tmpdir(), 'material-codex-probe-'));
      void directoryPromise.then((createdDirectory) => {
        if (probe.settled && probeDirectory === null) {
          void rm(createdDirectory, { force: true, recursive: true });
        }
      }).catch(() => undefined);
      probeDirectory = await Promise.race([
        directoryPromise,
        terminalPromise.then(() => {
          throw new CodexSubscriptionError('PROTOCOL_ERROR');
        }),
      ]);
      if (probe.settled || this.client?.getGeneration() !== generation) {
        await terminalPromise;
        throw new CodexSubscriptionError('RUNTIME_UNAVAILABLE');
      }
      this.patchState({ lastError: null, status: 'testing' });

      const threadResponse = await Promise.race([
        this.probeRequest<unknown>(probe, 'thread/start', {
          allowProviderModelFallback: false,
          approvalPolicy: 'never',
          baseInstructions: 'Perform only the fixed connectivity response. Never use tools.',
          cwd: probeDirectory,
          developerInstructions: 'Return the required JSON and take no other action.',
          dynamicTools: [],
          environments: [],
          ephemeral: true,
          model: modelId,
          runtimeWorkspaceRoots: [probeDirectory],
          sandbox: 'read-only',
          selectedCapabilityRoots: [],
          serviceName: 'material_desktop_model_probe',
        }),
        terminalPromise,
      ]);
      if (!isRecord(threadResponse)
        || !isRecord(threadResponse.thread)
        || !safeString(threadResponse.thread.id, 256)
        || threadResponse.thread.ephemeral !== true
        || !validIdentifier(threadResponse.model)) {
        throw new CodexSubscriptionError('PROTOCOL_ERROR');
      }
      probe.threadId = String(threadResponse.thread.id);
      probe.returnedModelId = threadResponse.model;
      this.interruptibleProbes.set(probe.threadId, probe);
      if (probe.settled || this.client?.getGeneration() !== generation) {
        await terminalPromise;
        throw new CodexSubscriptionError('RUNTIME_UNAVAILABLE');
      }

      turnRequestPending = true;
      const turnRequest = this.probeRequest<unknown>(probe, 'turn/start', {
          approvalPolicy: 'never',
          cwd: probeDirectory,
          environments: [],
          input: [{ text: PROBE_PROMPT, text_elements: [], type: 'text' }],
          model: modelId,
          outputSchema: PROBE_OUTPUT_SCHEMA,
          runtimeWorkspaceRoots: [probeDirectory],
          sandboxPolicy: { networkAccess: false, type: 'readOnly' },
          threadId: probe.threadId,
        }).then((response) => {
          this.bindTurnResponse(probe, response);
          return response;
        }).finally(() => {
          turnRequestPending = false;
          if (probe.threadId && this.activeProbe !== probe) {
            this.interruptibleProbes.delete(probe.threadId);
          }
        });
      const turnResponse = await Promise.race([
        turnRequest,
        terminalPromise,
      ]);
      this.bindTurnResponse(probe, turnResponse);
      await terminalPromise;
      let parsed: unknown;
      try {
        parsed = probe.finalText === null ? null : JSON.parse(probe.finalText);
      } catch {
        parsed = null;
      }
      if (!isRecord(parsed)
        || parsed.result !== 'OK'
        || Object.keys(parsed).length !== 1) {
        throw new CodexSubscriptionError('TEST_FAILED');
      }
      const result: CodexConnectivityTestResult = {
        checkedAt: this.now().toISOString(),
        durationMs: Math.max(0, Date.now() - startedAt),
        planType: this.state.planType,
        requestedModelId: modelId,
        returnedModelId: probe.returnedModelId,
      };
      this.patchState({ lastError: null, status: 'ready' });
      return result;
    } catch (error) {
      const normalized = this.normalizedProbeError(error);
      this.interruptProbe(probe);
      await this.applyProbeFailureState(normalized);
      throw normalized;
    } finally {
      clearTimeout(timeout);
      if (this.activeProbe === probe) this.activeProbe = null;
      if (probe.threadId && !turnRequestPending) {
        this.interruptibleProbes.delete(probe.threadId);
      }
      if (probeDirectory) await rm(probeDirectory, { force: true, recursive: true });
    }
  }

  async logout(): Promise<null> {
    await this.ensureOperational();
    this.assertNoActiveProbe();
    const generation = this.requireCurrentGeneration();
    this.accountEpoch += 1;
    if (this.activeLoginId) {
      const activeLoginId = this.activeLoginId;
      try {
        await this.clientRequest(generation, 'account/login/cancel', {
          loginId: activeLoginId,
        });
      } catch {
        // Logout remains authoritative; a failed best-effort cancellation is not retried.
      }
      await this.claimLoginOutcome(activeLoginId, false, null);
    }
    await this.clientRequest(generation, 'account/logout');
    const accountResponse = await this.clientRequest<unknown>(generation, 'account/read', {
      refreshToken: false,
    });
    if (!isRecord(accountResponse) || accountResponse.account !== null) {
      this.throwSidecarTrustFailure(generation, 'PROTOCOL_ERROR');
    }
    this.accountEpoch += 1;
    this.state = {
      ...this.state,
      accountLabel: null,
      lastError: null,
      models: [],
      pendingLoginId: null,
      planType: null,
      rateLimits: null,
      selectedModelId: null,
      status: 'signedOut',
    };
    await this.persistSelectedModel();
    this.emitState();
    return null;
  }

  stop(): void {
    this.clearLoginTimeout();
    if (this.activeProbe) {
      this.rejectProbe(new CodexSubscriptionError('TEST_FAILED'));
    }
    this.unsubscribeClientEvents.splice(0).forEach((unsubscribe) => unsubscribe());
    this.client?.stop();
  }

  private async initialize(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = this.initializeInternal();
    }
    await this.initializePromise;
  }

  private async initializeInternal(): Promise<void> {
    if (!this.client && this.options.clientFactory) {
      try {
        this.client = await this.options.clientFactory();
        this.attachClientEvents(this.client);
      } catch (error) {
        const normalized = this.normalized(error, 'RUNTIME_UNAVAILABLE');
        this.patchState({
          lastError: toPublicCodexError(normalized),
          status: 'unavailable',
        });
        return;
      }
    }
    await this.loadSelectedModel();
    if (!this.client) return;
    try {
      await this.client.start();
      const generation = this.requireCurrentGeneration();
      await this.refreshAccountInternal(false, this.accountEpoch, generation);
    } catch (error) {
      const normalized = this.normalized(error, 'RUNTIME_UNAVAILABLE');
      this.patchState({
        lastError: toPublicCodexError(normalized),
        status: normalized.code === 'RUNTIME_UNAVAILABLE' || isSidecarTrustFailure(normalized)
          ? 'unavailable' : 'error',
      });
    }
  }

  private async ensureOperational(): Promise<void> {
    await this.initialize();
    if (this.state.status === 'unavailable' && this.options.clientFactory) {
      if (!this.recoveryPromise) {
        const recovery = this.recoverRuntime();
        this.recoveryPromise = recovery;
        void recovery.finally(() => {
          if (this.recoveryPromise === recovery) this.recoveryPromise = null;
        }).catch(() => undefined);
      }
      await this.recoveryPromise;
    }
    if (!this.client || this.state.status === 'unavailable') {
      throw new CodexSubscriptionError('RUNTIME_UNAVAILABLE');
    }
  }

  private async recoverRuntime(): Promise<void> {
    this.unsubscribeClientEvents.splice(0).forEach((unsubscribe) => unsubscribe());
    this.client?.stop();
    this.client = null;
    try {
      this.client = await this.options.clientFactory?.() ?? null;
      if (!this.client) throw new CodexSubscriptionError('RUNTIME_UNAVAILABLE');
      this.attachClientEvents(this.client);
      await this.client.start();
      const generation = this.requireCurrentGeneration();
      await this.refreshAccountInternal(false, this.accountEpoch, generation);
    } catch (error) {
      const normalized = this.normalized(error, 'RUNTIME_UNAVAILABLE');
      this.patchState({ lastError: toPublicCodexError(normalized), status: 'unavailable' });
      throw normalized;
    }
  }

  private attachClientEvents(client: CodexAppServerPort): void {
    this.unsubscribeClientEvents.push(
      client.onNotification((notification) => {
        void this.handleNotification(notification).catch(() => undefined);
      }),
      client.onServerRequest(() => this.handleServerRequest()),
      client.onRuntimeClosed((event) => this.handleRuntimeClosed(event)),
    );
  }

  private async ensureSignedIn(): Promise<void> {
    await this.ensureOperational();
    if (!this.state.accountLabel) throw new CodexSubscriptionError('SIGNED_OUT');
  }

  private async clientRequest<T>(
    generation: number,
    method: string,
    params?: unknown,
  ): Promise<T> {
    if (!this.client) throw new CodexSubscriptionError('RUNTIME_UNAVAILABLE');
    try {
      const response = await this.client.requestIfRunning<T>(
        generation,
        method,
        params,
        CONTROL_REQUEST_TIMEOUT_MS,
      );
      if (this.client.getGeneration() !== generation) {
        throw new CodexSubscriptionError('RUNTIME_UNAVAILABLE');
      }
      return response;
    } catch (error) {
      if (isSidecarTrustFailure(error)) {
        this.client.invalidateGeneration(
          generation,
          (error as CodexSubscriptionError).code === 'PROTOCOL_ERROR'
            ? 'PROTOCOL_ERROR' : 'RUNTIME_UNAVAILABLE',
        );
      }
      throw error;
    }
  }

  private requireCurrentGeneration(): number {
    const generation = this.client?.getGeneration() ?? null;
    if (generation === null) throw new CodexSubscriptionError('RUNTIME_UNAVAILABLE');
    return generation;
  }

  private throwSidecarTrustFailure(
    generation: number | null,
    code: 'PROTOCOL_ERROR' | 'SECURITY_VIOLATION',
    invalidateImmediately = true,
  ): never {
    const error = new CodexSubscriptionError(code);
    if (invalidateImmediately && generation !== null && this.client) {
      this.client.invalidateGeneration(
        generation,
        code === 'PROTOCOL_ERROR' ? 'PROTOCOL_ERROR' : 'RUNTIME_UNAVAILABLE',
      );
    }
    throw error;
  }

  private probeRequest<T>(
    probe: ProbeContext,
    method: string,
    params: unknown,
  ): Promise<T> {
    if (probe.abortRequested || probe.settled) {
      return Promise.reject(new CodexSubscriptionError('TEST_TIMEOUT'));
    }
    if (!this.client || probe.generation === null) {
      return Promise.reject(new CodexSubscriptionError('RUNTIME_UNAVAILABLE'));
    }
    return this.client.requestIfRunning<T>(
      probe.generation,
      method,
      params,
      CONTROL_REQUEST_TIMEOUT_MS,
    ).then((response) => {
      if (this.client?.getGeneration() !== probe.generation) {
        throw new CodexSubscriptionError('RUNTIME_UNAVAILABLE');
      }
      return response;
    });
  }

  private async beginLogin(): Promise<number> {
    if (this.loginStarting || this.activeLoginId) {
      throw new CodexSubscriptionError('LOGIN_IN_PROGRESS');
    }
    if (this.state.accountLabel
      || (this.state.status !== 'signedOut'
        && !(this.state.status === 'error' && this.state.accountLabel === null))) {
      throw new CodexSubscriptionError('LOGIN_IN_PROGRESS');
    }
    this.accountEpoch += 1;
    const loginEpoch = this.accountEpoch;
    this.loginStarting = true;
    this.activeLoginGeneration = null;
    this.state = {
      ...this.state,
      accountLabel: null,
      lastError: null,
      models: [],
      pendingLoginId: null,
      planType: null,
      rateLimits: null,
      selectedModelId: null,
      status: 'loginPending',
    };
    try {
      await this.persistSelectedModel();
      this.emitState();
      return loginEpoch;
    } catch (error) {
      this.loginStarting = false;
      this.patchState({
        lastError: toPublicCodexError(error),
        status: 'error',
      });
      throw error;
    }
  }

  private activateLogin(loginId: string, generation: number): void {
    this.loginStarting = false;
    this.activeLoginId = loginId;
    this.activeLoginGeneration = generation;
    this.patchState({ pendingLoginId: loginId, status: 'loginPending' });
    this.scheduleLoginTimeout(loginId);
  }

  private failLoginStart(error: unknown, generation: number | null): void {
    this.loginStarting = false;
    this.clearLoginTimeout();
    this.earlyLoginCompletions.clear();
    const activeLoginId = this.activeLoginId;
    this.activeLoginId = null;
    this.activeLoginGeneration = null;
    this.patchState({
      lastError: toPublicCodexError(this.normalized(error, 'LOGIN_FAILED')),
      pendingLoginId: null,
      status: error instanceof CodexSubscriptionError
        && (error.code === 'RUNTIME_UNAVAILABLE'
          || error.code === 'PROTOCOL_ERROR'
          || error.code === 'SECURITY_VIOLATION') ? 'unavailable' : 'signedOut',
    });
    if (activeLoginId && generation !== null && this.client) {
      void this.client.requestIfRunning(
        generation,
        'account/login/cancel',
        { loginId: activeLoginId },
        CONTROL_REQUEST_TIMEOUT_MS,
      )
        .catch(() => undefined);
    }
  }

  private discardStaleLoginStart(loginId: string, generation: number): void {
    this.loginStarting = false;
    this.earlyLoginCompletions.clear();
    this.activeLoginGeneration = null;
    this.rememberSettledLoginId(loginId);
    if (!this.client) return;
    void this.client.requestIfRunning(
      generation,
      'account/login/cancel',
      { loginId },
      CONTROL_REQUEST_TIMEOUT_MS,
    ).catch(() => undefined);
  }

  private rememberSettledLoginId(loginId: string): void {
    this.settledLoginIds.add(loginId);
    if (this.settledLoginIds.size > 100) {
      const oldest = this.settledLoginIds.values().next().value;
      if (typeof oldest === 'string') this.settledLoginIds.delete(oldest);
    }
  }

  private assertNoActiveProbe(): void {
    if (!this.activeProbe) return;
    this.rejectProbe(new CodexSubscriptionError('TEST_FAILED'));
    throw new CodexSubscriptionError('TEST_FAILED');
  }

  private assertAccountEpoch(expectedEpoch: number): void {
    if (this.accountEpoch !== expectedEpoch) {
      throw new CodexSubscriptionError('TEST_FAILED');
    }
  }

  private scheduleLoginTimeout(loginId: string): void {
    this.clearLoginTimeout();
    this.loginTimeout = setTimeout(() => {
      void this.expireLogin(loginId).catch(() => undefined);
    }, this.loginTimeoutMs);
    this.loginTimeout.unref?.();
  }

  private clearLoginTimeout(): void {
    if (this.loginTimeout) clearTimeout(this.loginTimeout);
    this.loginTimeout = null;
  }

  private async expireLogin(loginId: string): Promise<void> {
    if (this.activeLoginId !== loginId) return;
    const generation = this.activeLoginGeneration;
    this.clearLoginTimeout();
    const terminal = this.claimLoginOutcome(
      loginId,
      false,
      new CodexSubscriptionError('LOGIN_FAILED'),
    );
    const cancel = this.client && generation !== null
      ? this.client.requestIfRunning(
        generation,
        'account/login/cancel',
        { loginId },
        CONTROL_REQUEST_TIMEOUT_MS,
      ).catch(() => undefined)
      : Promise.resolve();
    const reconciliation = terminal.then(() => this.reconcileSettledLogin(generation));
    this.loginReconciliationPromise = reconciliation;
    void reconciliation.finally(() => {
      if (this.loginReconciliationPromise === reconciliation) {
        this.loginReconciliationPromise = null;
      }
    }).catch(() => undefined);
    // Cancellation and the authoritative read may race the remote completion, but
    // neither is allowed to reopen the already-terminal local login attempt.
    await Promise.allSettled([cancel, reconciliation]);
  }

  private async reconcileSettledLogin(generation?: number | null): Promise<void> {
    const hydration = this.loginHydrationPromise;
    if (hydration) await hydration.catch(() => undefined);
    if (this.activeProbe || this.loginStarting || this.activeLoginId) return;
    const epoch = this.accountEpoch;
    const expectedGeneration = generation === undefined
      ? this.requireCurrentGeneration()
      : generation;
    if (expectedGeneration === null) {
      throw new CodexSubscriptionError('RUNTIME_UNAVAILABLE');
    }
    await this.refreshAccountInternal(false, epoch, expectedGeneration);
  }

  private applyEarlyLoginCompletion(loginId: string): void {
    const completion = this.earlyLoginCompletions.get(loginId);
    if (!completion) return;
    this.earlyLoginCompletions.delete(loginId);
    void this.claimLoginOutcome(loginId, completion.success, completion.error)
      .catch((claimError) => {
        const normalized = this.normalized(claimError, 'LOGIN_FAILED');
        this.patchState({
          lastError: toPublicCodexError(normalized),
          status: normalized.code === 'RUNTIME_UNAVAILABLE' || isSidecarTrustFailure(normalized)
            ? 'unavailable' : 'error',
        });
      });
  }

  private async claimLoginOutcome(
    loginId: string,
    success: boolean,
    error: unknown,
  ): Promise<void> {
    if (this.settledLoginIds.has(loginId)) {
      if (success && !this.activeProbe && !this.loginHydrationPromise) {
        const reconciliation = this.reconcileSettledLogin();
        this.loginReconciliationPromise = reconciliation;
        try {
          await reconciliation;
        } finally {
          if (this.loginReconciliationPromise === reconciliation) {
            this.loginReconciliationPromise = null;
          }
        }
      }
      return;
    }
    if (this.activeLoginId !== loginId) return;
    this.rememberSettledLoginId(loginId);
    this.clearLoginTimeout();
    this.loginStarting = false;
    const loginGeneration = this.activeLoginGeneration;
    this.activeLoginId = null;
    this.activeLoginGeneration = null;
    this.earlyLoginCompletions.clear();
    this.accountEpoch += 1;
    const outcomeEpoch = this.accountEpoch;
    this.state = {
      ...this.state,
      accountLabel: null,
      lastError: null,
      models: [],
      pendingLoginId: null,
      planType: null,
      rateLimits: null,
      selectedModelId: null,
      status: success ? 'loginPending' : 'signedOut',
    };
    this.emitState();
    await this.persistSelectedModel();

    if (!success) {
      const publicError = error === null || error === undefined
        ? null
        : toPublicCodexError(
          error instanceof CodexSubscriptionError
            ? error
            : new CodexSubscriptionError('LOGIN_FAILED'),
        );
      this.patchState({ lastError: publicError, status: 'signedOut' });
      this.emitLoginCompleted({ error: publicError, loginId, success: false });
      return;
    }

    if (loginGeneration === null) throw new CodexSubscriptionError('RUNTIME_UNAVAILABLE');
    const hydration = this.refreshAccountInternal(true, outcomeEpoch, loginGeneration);
    this.loginHydrationPromise = hydration;
    try {
      await hydration;
      if (!this.state.accountLabel
        || (this.state.status !== 'ready' && this.state.status !== 'limited')) {
        throw new CodexSubscriptionError('LOGIN_FAILED');
      }
      this.emitLoginCompleted({ error: null, loginId, success: true });
    } catch (refreshError) {
      const normalized = this.normalized(refreshError, 'LOGIN_FAILED');
      const publicError = toPublicCodexError(normalized);
      this.patchState({
        lastError: publicError,
        status: normalized.code === 'RUNTIME_UNAVAILABLE' || isSidecarTrustFailure(normalized)
          ? 'unavailable'
          : normalized.code === 'SIGNED_OUT' ? 'signedOut' : 'error',
      });
      this.emitLoginCompleted({ error: publicError, loginId, success: false });
    } finally {
      if (this.loginHydrationPromise === hydration) this.loginHydrationPromise = null;
    }
  }

  private async refreshAccountInternal(
    refreshToken: boolean,
    expectedEpoch: number,
    generation: number,
  ): Promise<void> {
    try {
      const account = await this.readChatGptAccount(refreshToken, generation);
      this.assertAccountEpoch(expectedEpoch);
      if (account === null) {
        this.accountEpoch += 1;
        await this.applySignedOutState();
        return;
      }
      const [models, limits] = await Promise.all([
        this.fetchModels(generation),
        this.fetchRateLimits(generation),
      ]);
      this.assertAccountEpoch(expectedEpoch);
      const selectedModelId = this.state.selectedModelId
        && models.some((model) => model.id === this.state.selectedModelId)
        ? this.state.selectedModelId
        : null;
      const selectionChanged = selectedModelId !== this.state.selectedModelId;
      this.state = {
        ...this.state,
        accountLabel: account.accountLabel,
        lastError: null,
        models,
        pendingLoginId: this.activeLoginId,
        planType: account.planType,
        rateLimits: limits,
        selectedModelId,
        status: isLimited(limits) ? 'limited' : 'ready',
      };
      if (selectionChanged) await this.persistSelectedModel();
      this.emitState();
      this.emitRateLimits(limits);
    } catch (error) {
      const normalized = error instanceof CodexSubscriptionError
        ? error
        : new CodexSubscriptionError('UNKNOWN');
      if (this.accountEpoch !== expectedEpoch) throw normalized;
      this.state.models = [];
      this.state.rateLimits = null;
      this.state.selectedModelId = null;
      await this.persistSelectedModel().catch(() => undefined);
      this.patchState({
        lastError: toPublicCodexError(normalized),
        status: normalized.code === 'RUNTIME_UNAVAILABLE' || isSidecarTrustFailure(normalized)
          ? 'unavailable' : 'error',
      });
      throw normalized;
    }
  }

  private async refreshModelsInternal(
    expectedEpoch: number,
    generation: number,
  ): Promise<void> {
    try {
      const models = await this.fetchModels(generation);
      this.assertAccountEpoch(expectedEpoch);
      this.state.models = models;
      if (this.state.selectedModelId
        && !models.some((model) => model.id === this.state.selectedModelId)) {
        this.state.selectedModelId = null;
        await this.persistSelectedModel();
      }
      this.emitState();
    } catch (error) {
      const normalized = error instanceof CodexSubscriptionError
        ? error
        : new CodexSubscriptionError('UNKNOWN');
      if (this.accountEpoch !== expectedEpoch) throw normalized;
      this.state.models = [];
      this.state.selectedModelId = null;
      await this.persistSelectedModel().catch(() => undefined);
      this.patchState({
        lastError: toPublicCodexError(normalized),
        status: normalized.code === 'RUNTIME_UNAVAILABLE' || isSidecarTrustFailure(normalized)
          ? 'unavailable' : 'error',
      });
      throw normalized;
    }
  }

  private async refreshRateLimitsInternal(
    expectedEpoch: number,
    generation: number,
  ): Promise<void> {
    try {
      const limits = await this.fetchRateLimits(generation);
      this.assertAccountEpoch(expectedEpoch);
      this.state.rateLimits = limits;
      if (this.state.status === 'ready' || this.state.status === 'limited') {
        this.state.status = isLimited(limits) ? 'limited' : 'ready';
      }
      this.emitState();
      this.emitRateLimits(limits);
    } catch (error) {
      const normalized = error instanceof CodexSubscriptionError
        ? error
        : new CodexSubscriptionError('UNKNOWN');
      if (this.accountEpoch !== expectedEpoch) throw normalized;
      this.state.rateLimits = null;
      this.patchState({
        lastError: toPublicCodexError(normalized),
        status: normalized.code === 'RUNTIME_UNAVAILABLE' || isSidecarTrustFailure(normalized)
          ? 'unavailable' : 'error',
      });
      throw normalized;
    }
  }

  private async readChatGptAccount(
    refreshToken: boolean,
    generation: number,
    probe?: ProbeContext,
  ): Promise<{ accountLabel: string; planType: string | null } | null> {
    const response = probe
      ? await this.probeRequest<AccountReadResponse>(probe, 'account/read', { refreshToken })
      : await this.clientRequest<AccountReadResponse>(
        generation,
        'account/read',
        { refreshToken },
      );
    if (!isRecord(response) || !('account' in response)) {
      this.throwSidecarTrustFailure(generation, 'PROTOCOL_ERROR', probe === undefined);
    }
    if (response.account === null) return null;
    if (!isRecord(response.account) || response.account.type !== 'chatgpt') {
      this.throwSidecarTrustFailure(generation, 'SECURITY_VIOLATION', probe === undefined);
    }
    const email = response.account.email === null
      ? null
      : safeString(response.account.email, 320);
    return {
      accountLabel: maskCodexAccountEmail(email),
      planType: safeString(response.account.planType, 80),
    };
  }

  private async fetchModels(
    generation: number,
    probe?: ProbeContext,
  ): Promise<CodexModelSummary[]> {
    const models: CodexModelSummary[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
      const params = {
          cursor,
          includeHidden: false,
          limit: 100,
        };
      const response: ModelListResponse = probe
        ? await this.probeRequest<ModelListResponse>(probe, 'model/list', params)
        : await this.clientRequest<ModelListResponse>(generation, 'model/list', params);
      if (!isRecord(response) || !Array.isArray(response.data)) {
        this.throwSidecarTrustFailure(generation, 'PROTOCOL_ERROR', probe === undefined);
      }
      for (const entry of response.data) {
        const model = mapModel(entry);
        if (!model || seen.has(model.id)) continue;
        if (models.length >= MAX_MODELS) {
          this.throwSidecarTrustFailure(generation, 'PROTOCOL_ERROR', probe === undefined);
        }
        models.push(model);
        seen.add(model.id);
      }
      if (response.nextCursor === null || response.nextCursor === undefined) break;
      if (typeof response.nextCursor !== 'string'
        || response.nextCursor.length === 0
        || response.nextCursor.length > 1024) {
        this.throwSidecarTrustFailure(generation, 'PROTOCOL_ERROR', probe === undefined);
      }
      cursor = response.nextCursor;
      if (page === MAX_MODEL_PAGES - 1) {
        this.throwSidecarTrustFailure(generation, 'PROTOCOL_ERROR', probe === undefined);
      }
    }
    return models;
  }

  private async fetchRateLimits(
    generation: number,
    probe?: ProbeContext,
  ): Promise<CodexRateLimitsSummary> {
    const response = probe
      ? await this.probeRequest<unknown>(probe, 'account/rateLimits/read', undefined)
      : await this.clientRequest<unknown>(generation, 'account/rateLimits/read');
    if (!isRecord(response)) {
      this.throwSidecarTrustFailure(generation, 'PROTOCOL_ERROR', probe === undefined);
    }
    const buckets: CodexRateLimitBucket[] = [];
    const byLimitId = response.rateLimitsByLimitId;
    if (isRecord(byLimitId)) {
      Object.entries(byLimitId).forEach(([limitId, value]) => {
        const bucket = mapRateLimitBucket(value, limitId);
        if (bucket) buckets.push(bucket);
      });
    }
    if (buckets.length === 0) {
      const fallback = mapRateLimitBucket(response.rateLimits);
      if (fallback) buckets.push(fallback);
    }
    let resetCreditsAvailable: number | null = null;
    if (isRecord(response.rateLimitResetCredits)) {
      const count = response.rateLimitResetCredits.availableCount;
      if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) {
        resetCreditsAvailable = count;
      } else if (typeof count === 'string' && /^\d{1,15}$/.test(count)) {
        const parsed = Number(count);
        if (Number.isSafeInteger(parsed)) resetCreditsAvailable = parsed;
      }
    }
    return {
      buckets,
      checkedAt: this.now().toISOString(),
      resetCreditsAvailable,
    };
  }

  private async applySignedOutState(): Promise<void> {
    this.state = {
      ...this.state,
      accountLabel: null,
      lastError: null,
      models: [],
      pendingLoginId: this.activeLoginId,
      planType: null,
      rateLimits: null,
      selectedModelId: null,
      status: this.activeLoginId ? 'loginPending' : 'signedOut',
    };
    await this.persistSelectedModel();
    this.emitState();
  }

  private async preflightProbe(probe: ProbeContext, modelId: string): Promise<void> {
    if (probe.generation === null) throw new CodexSubscriptionError('RUNTIME_UNAVAILABLE');
    const generation = probe.generation;
    const account = await this.readChatGptAccount(false, generation, probe);
    if (account === null) {
      await this.applySignedOutState();
      throw new CodexSubscriptionError('SIGNED_OUT');
    }
    const [models, limits] = await Promise.all([
      this.fetchModels(generation, probe),
      this.fetchRateLimits(generation, probe),
    ]);
    const selectedStillAvailable = models.some((model) => model.id === modelId);
    this.state = {
      ...this.state,
      accountLabel: account.accountLabel,
      lastError: null,
      models,
      planType: account.planType,
      rateLimits: limits,
      selectedModelId: selectedStillAvailable ? modelId : null,
      status: isLimited(limits) ? 'limited' : selectedStillAvailable ? 'ready' : 'error',
    };
    if (!selectedStillAvailable) await this.persistSelectedModel();
    this.emitState();
    this.emitRateLimits(limits);
    if (!selectedStillAvailable) throw new CodexSubscriptionError('MODEL_UNAVAILABLE');
    if (isLimited(limits)) throw new CodexSubscriptionError('RATE_LIMITED');
  }

  private async applyProbeFailureState(error: CodexSubscriptionError): Promise<void> {
    if (error.code === 'SIGNED_OUT') {
      await this.applySignedOutState();
      this.patchState({ lastError: toPublicCodexError(error), status: 'signedOut' });
      return;
    }
    if (isSidecarTrustFailure(error)) {
      const generation = this.activeProbe?.generation ?? null;
      if (generation !== null && this.client) {
        this.client.invalidateGeneration(
          generation,
          error.code === 'PROTOCOL_ERROR' ? 'PROTOCOL_ERROR' : 'RUNTIME_UNAVAILABLE',
        );
      }
      this.patchState({ lastError: toPublicCodexError(error), status: 'unavailable' });
      return;
    }
    this.patchState({
      lastError: toPublicCodexError(error),
      status: error.code === 'RUNTIME_UNAVAILABLE'
        ? 'unavailable'
        : error.code === 'RATE_LIMITED' ? 'limited' : 'error',
    });
  }

  private emitLoginCompleted(event: CodexLoginCompletedEvent): void {
    this.loginListeners.forEach((listener) => {
      try {
        listener(event);
      } catch {
        // Renderer event listeners cannot break the main-process state machine.
      }
    });
  }

  private emitRateLimits(limits: CodexRateLimitsSummary): void {
    const snapshot = cloneState({ ...this.state, rateLimits: limits }).rateLimits;
    if (!snapshot) return;
    this.rateLimitListeners.forEach((listener) => {
      try {
        listener(snapshot);
      } catch {
        // Renderer event listeners cannot break the main-process state machine.
      }
    });
  }

  private async loadSelectedModel(): Promise<void> {
    try {
      const metadata = await lstat(this.options.settingsPath);
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_SETTINGS_BYTES) {
        return;
      }
      const handle = await open(this.options.settingsPath, 'r');
      let content: string;
      try {
        const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_SETTINGS_BYTES) return;
        content = buffer.subarray(0, bytesRead).toString('utf8');
      } finally {
        await handle.close();
      }
      const parsed: unknown = JSON.parse(content);
      if (isRecord(parsed)
        && (parsed.selectedModelId === null || validIdentifier(parsed.selectedModelId))) {
        this.state.selectedModelId = parsed.selectedModelId;
      }
    } catch {
      // A missing or malformed non-secret preference falls back to no selection.
    }
  }

  private async persistSelectedModel(): Promise<void> {
    const selectedModelId = this.state.selectedModelId;
    this.settingsWriteCounter += 1;
    const writeId = this.settingsWriteCounter;
    const operation = this.settingsWriteQueue.catch(() => undefined).then(async () => {
      const directory = path.dirname(this.options.settingsPath);
      await mkdir(directory, { mode: 0o700, recursive: true });
      const temporaryPath = `${this.options.settingsPath}.${process.pid}.${writeId}.tmp`;
      try {
        await writeFile(temporaryPath, JSON.stringify({ selectedModelId }), {
          encoding: 'utf8',
          mode: 0o600,
        });
        await rename(temporaryPath, this.options.settingsPath);
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    });
    this.settingsWriteQueue = operation;
    await operation;
  }

  private async handleNotification(notification: CodexAppServerNotification): Promise<void> {
    if (notification.method === 'account/login/completed') {
      if (!isRecord(notification.params)
        || !LOGIN_ID_PATTERN.test(String(notification.params.loginId ?? ''))
        || typeof notification.params.success !== 'boolean') return;
      const loginId = String(notification.params.loginId);
      if (this.loginStarting && this.activeLoginId === null) {
        const existingLoginId = this.earlyLoginCompletions.keys().next().value;
        if (typeof existingLoginId === 'string' && existingLoginId !== loginId) {
          this.earlyLoginCompletions.clear();
          this.loginStarting = false;
          const protocolError = new CodexSubscriptionError('PROTOCOL_ERROR');
          const generation = this.client?.getGeneration() ?? null;
          if (generation !== null) {
            this.client?.invalidateGeneration(generation, 'PROTOCOL_ERROR');
          }
          this.patchState({
            lastError: toPublicCodexError(protocolError),
            pendingLoginId: null,
            status: 'unavailable',
          });
          return;
        }
        this.earlyLoginCompletions.set(loginId, {
          error: notification.params.error,
          loginId,
          success: notification.params.success,
        });
        return;
      }
      await this.claimLoginOutcome(
        loginId,
        notification.params.success,
        notification.params.error,
      );
      return;
    }
    if (notification.method === 'account/updated') {
      if (!this.loginStarting
        && !this.activeLoginId
        && !this.loginHydrationPromise
        && !this.activeProbe) {
        this.accountEpoch += 1;
        const generation = this.requireCurrentGeneration();
        await this.refreshAccountInternal(false, this.accountEpoch, generation);
      }
      return;
    }
    if (notification.method === 'account/rateLimits/updated') {
      if (this.state.accountLabel && !this.loginHydrationPromise && !this.activeProbe) {
        const generation = this.requireCurrentGeneration();
        await this.refreshRateLimitsInternal(this.accountEpoch, generation);
      }
      return;
    }
    this.handleProbeNotification(notification);
  }

  private handleServerRequest(): void {
    if (this.activeProbe) {
      this.rejectProbe(new CodexSubscriptionError('SECURITY_VIOLATION'));
    }
  }

  private handleProbeNotification(notification: CodexAppServerNotification): void {
    const forbiddenMethod = /(^|\/)(command|fileChange|mcp|mcpServer|webSearch|tool|hook|app|fs|process)(\/|$)/i
      .test(notification.method);
    if (forbiddenMethod && this.activeProbe) {
      this.rejectProbe(new CodexSubscriptionError('SECURITY_VIOLATION'));
      return;
    }
    const params = isRecord(notification.params) ? notification.params : null;
    const threadId = params ? safeString(params.threadId, 256) : null;
    const probe = this.activeProbe && notificationBelongsToProbe(
      this.activeProbe,
      notification.params,
    )
      ? this.activeProbe
      : threadId ? this.interruptibleProbes.get(threadId) ?? null : null;
    if (!probe || !notificationBelongsToProbe(probe, notification.params)) return;

    if (notification.method === 'turn/started') {
      const turn = params?.turn;
      const incomingTurnId = isRecord(turn) ? safeString(turn.id, 256) : null;
      if (!incomingTurnId) {
        if (!probe.settled) this.rejectProbe(new CodexSubscriptionError('PROTOCOL_ERROR'));
        return;
      }
      try {
        this.bindTurnId(probe, incomingTurnId);
      } catch (error) {
        if (!probe.settled) this.rejectProbe(error as Error);
      }
      return;
    }
    if (probe.settled) {
      if (notification.method === 'turn/completed') {
        const turn = params?.turn;
        const incomingTurnId = isRecord(turn) ? safeString(turn.id, 256) : null;
        if (incomingTurnId) {
          try {
            this.bindTurnId(probe, incomingTurnId);
          } catch {
            // The probe has already failed closed; a mismatched late turn stays ignored.
          }
        }
      }
      return;
    }
    if (notification.method === 'model/rerouted') {
      this.rejectProbe(new CodexSubscriptionError('MODEL_UNAVAILABLE'));
      return;
    }
    if (notification.method === 'error') {
      const info = isRecord(notification.params)
        && isRecord(notification.params.error)
        ? notification.params.error.codexErrorInfo
        : null;
      const errorType = codexErrorType(info);
      const code = errorType === 'usageLimitExceeded' ? 'RATE_LIMITED'
        : errorType === 'unauthorized' ? 'SIGNED_OUT'
          : 'TEST_FAILED';
      this.rejectProbe(new CodexSubscriptionError(code));
      return;
    }
    if (notification.method === 'item/started'
      || notification.method === 'item/completed') {
      const item = isRecord(notification.params) ? notification.params.item : null;
      if (!allowedProbeItem(item)) {
        this.rejectProbe(new CodexSubscriptionError('SECURITY_VIOLATION'));
        return;
      }
      if (notification.method === 'item/completed'
        && isRecord(item)
        && item.type === 'agentMessage'
        && typeof item.text === 'string') {
        probe.finalText = item.text;
      }
      return;
    }
    if (notification.method === 'turn/completed') {
      const turn = isRecord(notification.params) ? notification.params.turn : null;
      const incomingTurnId = isRecord(turn) ? safeString(turn.id, 256) : null;
      if (!isRecord(turn)
        || !incomingTurnId
        || (probe.turnId !== null && incomingTurnId !== probe.turnId)
        || !Array.isArray(turn.items)) {
        this.rejectProbe(new CodexSubscriptionError('PROTOCOL_ERROR'));
        return;
      }
      if (probe.turnId === null) probe.turnId = incomingTurnId;
      for (const item of turn.items) {
        if (!allowedProbeItem(item)) {
          this.rejectProbe(new CodexSubscriptionError('SECURITY_VIOLATION'));
          return;
        }
        if (isRecord(item) && item.type === 'agentMessage' && typeof item.text === 'string') {
          probe.finalText = item.text;
        }
      }
      if (turn.status !== 'completed') {
        const info = isRecord(turn.error) ? turn.error.codexErrorInfo : null;
        const errorType = codexErrorType(info);
        const code = errorType === 'usageLimitExceeded' ? 'RATE_LIMITED'
          : errorType === 'unauthorized' ? 'SIGNED_OUT'
            : 'TEST_FAILED';
        this.rejectProbe(new CodexSubscriptionError(code));
        return;
      }
      probe.settled = true;
      probe.resolve();
    }
  }

  private rejectProbe(error: Error): void {
    const probe = this.activeProbe;
    if (!probe || probe.settled) return;
    probe.abortRequested = true;
    probe.settled = true;
    this.interruptProbe(probe);
    probe.reject(error);
  }

  private interruptProbe(probe: ProbeContext): void {
    probe.abortRequested = true;
    if (probe.interrupted
      || !probe.threadId
      || !probe.turnId
      || probe.generation === null
      || !this.client
      || this.client.getGeneration() !== probe.generation) return;
    probe.interrupted = true;
    void this.client.requestIfRunning(probe.generation, 'turn/interrupt', {
      threadId: probe.threadId,
      turnId: probe.turnId,
    }, 1000).catch(() => undefined);
  }

  private bindTurnId(probe: ProbeContext, turnId: string): void {
    if (probe.turnId !== null && probe.turnId !== turnId) {
      throw new CodexSubscriptionError('PROTOCOL_ERROR');
    }
    probe.turnId = turnId;
    if (probe.abortRequested) this.interruptProbe(probe);
  }

  private bindTurnResponse(probe: ProbeContext, response: unknown): void {
    if (!isRecord(response)
      || !isRecord(response.turn)
      || !safeString(response.turn.id, 256)) {
      throw new CodexSubscriptionError('PROTOCOL_ERROR');
    }
    this.bindTurnId(probe, String(response.turn.id));
  }

  private handleRuntimeClosed(event: CodexAppServerRuntimeClosedEvent): void {
    const error = new CodexSubscriptionError(event.code);
    if (this.activeProbe
      && (this.activeProbe.generation === null
        || this.activeProbe.generation === event.generation)) {
      this.rejectProbe(error);
    }
    this.interruptibleProbes.clear();
    const loginId = this.activeLoginId;
    if (loginId) this.settledLoginIds.add(loginId);
    const hadLogin = this.loginStarting || loginId !== null;
    this.accountEpoch += 1;
    this.loginStarting = false;
    this.activeLoginId = null;
    this.activeLoginGeneration = null;
    this.clearLoginTimeout();
    this.earlyLoginCompletions.clear();
    this.state = {
      ...this.state,
      accountLabel: null,
      lastError: toPublicCodexError(error),
      models: [],
      pendingLoginId: null,
      planType: null,
      rateLimits: null,
      selectedModelId: null,
      status: 'unavailable',
    };
    void this.persistSelectedModel().catch(() => undefined);
    this.emitState();
    if (hadLogin) {
      this.emitLoginCompleted({
        error: toPublicCodexError(error),
        loginId,
        success: false,
      });
    }
  }

  private normalized(error: unknown, fallback: 'LOGIN_FAILED' | 'RUNTIME_UNAVAILABLE'):
  CodexSubscriptionError {
    if (error instanceof CodexSubscriptionError) return error;
    if (error instanceof CodexAppServerRequestError) {
      return new CodexSubscriptionError(fallback === 'RUNTIME_UNAVAILABLE'
        ? 'PROTOCOL_ERROR'
        : fallback);
    }
    return new CodexSubscriptionError(fallback);
  }

  private normalizedProbeError(error: unknown): CodexSubscriptionError {
    if (error instanceof CodexSubscriptionError) return error;
    return new CodexSubscriptionError('TEST_FAILED');
  }

  private patchState(patch: Partial<CodexSubscriptionState>): void {
    this.state = { ...this.state, ...patch };
    this.emitState();
  }

  private emitState(): void {
    const snapshot = cloneState(this.state);
    this.stateListeners.forEach((listener) => listener(snapshot));
  }
}

export type { CodexAppServerClient };
