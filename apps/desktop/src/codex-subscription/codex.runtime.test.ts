import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { CodexAppServerClient } from './client';
import {
  buildCodexEnvironment,
  prepareCodexHome,
  resolveCodexRuntimePath,
  verifyCodexRuntimeVersion,
} from './runtime';

const execFileAsync = promisify(execFile);

const removeWithRuntimeRetry = async (directory: string): Promise<void> => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(directory, { force: true, recursive: true });
      return;
    } catch (error) {
      if (attempt === 9) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
};

describe('locked Codex App Server runtime compatibility', () => {
  it('starts with strict isolated config and reads a signed-out account without logging in',
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'material-codex-real-runtime-'));
      let client: CodexAppServerClient | null = null;
      try {
        const command = await resolveCodexRuntimePath({
          isPackaged: false,
          resourcesPath: process.resourcesPath,
        });
        const codexHome = await prepareCodexHome(
          path.join(directory, 'codex-subscription', 'codex-home'),
        );
        const environment = buildCodexEnvironment(codexHome, process.env);
        await verifyCodexRuntimeVersion({ codexHome, command, environment });
        const bindingsDirectory = path.join(directory, 'experimental-bindings');
        await mkdir(bindingsDirectory);
        await execFileAsync(command, [
          'app-server',
          'generate-ts',
          '--experimental',
          '--out',
          bindingsDirectory,
        ], {
          cwd: codexHome,
          env: environment,
          timeout: 30_000,
          windowsHide: true,
        });
        const [
          threadStart,
          threadStartResponse,
          turnStart,
          sandboxPolicy,
          model,
          inputModality,
          userInput,
          thread,
          rateLimitsResponse,
          tokenUsageBreakdown,
          turn,
          threadItem,
          itemStartedNotification,
          itemCompletedNotification,
          turnStartedNotification,
          turnCompletedNotification,
          tokenUsageNotification,
          reroutedNotification,
          errorNotification,
          accountUpdatedNotification,
        ] = await Promise.all([
          readFile(path.join(bindingsDirectory, 'v2', 'ThreadStartParams.ts'), 'utf8'),
          readFile(path.join(bindingsDirectory, 'v2', 'ThreadStartResponse.ts'), 'utf8'),
          readFile(path.join(bindingsDirectory, 'v2', 'TurnStartParams.ts'), 'utf8'),
          readFile(path.join(bindingsDirectory, 'v2', 'SandboxPolicy.ts'), 'utf8'),
          readFile(path.join(bindingsDirectory, 'v2', 'Model.ts'), 'utf8'),
          readFile(path.join(bindingsDirectory, 'InputModality.ts'), 'utf8'),
          readFile(path.join(bindingsDirectory, 'v2', 'UserInput.ts'), 'utf8'),
          readFile(path.join(bindingsDirectory, 'v2', 'Thread.ts'), 'utf8'),
          readFile(path.join(bindingsDirectory, 'v2', 'GetAccountRateLimitsResponse.ts'), 'utf8'),
          readFile(path.join(bindingsDirectory, 'v2', 'TokenUsageBreakdown.ts'), 'utf8'),
          readFile(path.join(bindingsDirectory, 'v2', 'Turn.ts'), 'utf8'),
          readFile(path.join(bindingsDirectory, 'v2', 'ThreadItem.ts'), 'utf8'),
          readFile(path.join(bindingsDirectory, 'v2', 'ItemStartedNotification.ts'), 'utf8'),
          readFile(path.join(bindingsDirectory, 'v2', 'ItemCompletedNotification.ts'), 'utf8'),
          readFile(path.join(bindingsDirectory, 'v2', 'TurnStartedNotification.ts'), 'utf8'),
          readFile(path.join(bindingsDirectory, 'v2', 'TurnCompletedNotification.ts'), 'utf8'),
          readFile(
            path.join(bindingsDirectory, 'v2', 'ThreadTokenUsageUpdatedNotification.ts'),
            'utf8',
          ),
          readFile(path.join(bindingsDirectory, 'v2', 'ModelReroutedNotification.ts'), 'utf8'),
          readFile(path.join(bindingsDirectory, 'v2', 'ErrorNotification.ts'), 'utf8'),
          readFile(path.join(bindingsDirectory, 'v2', 'AccountUpdatedNotification.ts'), 'utf8'),
        ]);
        [
          'allowProviderModelFallback',
          'approvalPolicy',
          'config',
          'cwd',
          'dynamicTools',
          'environments',
          'ephemeral',
          'model',
          'runtimeWorkspaceRoots',
          'sandbox',
          'selectedCapabilityRoots',
        ].forEach((field) => expect(threadStart).toContain(`${field}?:`));
        [
          'approvalPolicy',
          'cwd',
          'effort',
          'environments',
          'model',
          'outputSchema',
          'runtimeWorkspaceRoots',
          'sandboxPolicy',
          'summary',
        ].forEach((field) => expect(turnStart).toContain(`${field}?:`));
        expect(turnStart).toContain('threadId: string');
        expect(turnStart).toContain('input: Array<UserInput>');
        [
          'activePermissionProfile',
          'approvalPolicy',
          'cwd',
          'instructionSources',
          'model',
          'modelProvider',
          'serviceTier',
          'approvalsReviewer',
          'reasoningEffort',
          'runtimeWorkspaceRoots',
          'sandbox',
          'multiAgentMode',
        ].forEach((field) => expect(threadStartResponse).toContain(`${field}:`));
        expect(sandboxPolicy).toContain('"type": "readOnly", networkAccess: boolean');
        expect(sandboxPolicy).not.toMatch(/readableRoots|fullAccess/);
        [
          'id',
          'model',
          'upgrade',
          'upgradeInfo',
          'availabilityNux',
          'displayName',
          'description',
          'modelSpecialty',
          'hidden',
          'supportedReasoningEfforts',
          'defaultReasoningEffort',
          'inputModalities',
          'supportsPersonality',
          'multiAgentVersion',
          'additionalSpeedTiers',
          'serviceTiers',
          'defaultServiceTier',
          'isDefault',
        ].forEach((field) => expect(model).toContain(`${field}:`));
        expect(inputModality).toContain('"text" | "image" | "audio"');
        expect(userInput).toContain('{ "type": "localImage"');
        expect(userInput).toContain('path: string');
        expect(userInput).toContain('{ "type": "image"');
        expect(userInput).toContain('url: string');
        expect(thread).toContain('modelProvider: string');
        expect(thread).toContain('cwd: AbsolutePathBuf');
        ['path', 'turns', 'forkedFromId', 'parentThreadId', 'source']
          .forEach((field) => expect(thread).toContain(`${field}:`));
        ['id', 'items', 'itemsView', 'status', 'error', 'startedAt', 'completedAt', 'durationMs']
          .forEach((field) => expect(turn).toContain(`${field}:`));
        ['userMessage', 'agentMessage', 'reasoning', 'commandExecution', 'fileChange', 'webSearch']
          .forEach((itemType) => expect(threadItem).toContain(`"type": "${itemType}"`));
        ['item', 'threadId', 'turnId', 'startedAtMs']
          .forEach((field) => expect(itemStartedNotification).toContain(`${field}:`));
        ['item', 'threadId', 'turnId', 'completedAtMs']
          .forEach((field) => expect(itemCompletedNotification).toContain(`${field}:`));
        [turnStartedNotification, turnCompletedNotification].forEach((notification) => {
          expect(notification).toContain('threadId: string');
          expect(notification).toContain('turn: Turn');
        });
        ['threadId', 'turnId', 'tokenUsage']
          .forEach((field) => expect(tokenUsageNotification).toContain(`${field}:`));
        ['threadId', 'turnId', 'fromModel', 'toModel', 'reason']
          .forEach((field) => expect(reroutedNotification).toContain(`${field}:`));
        ['error', 'willRetry', 'threadId', 'turnId']
          .forEach((field) => expect(errorNotification).toContain(`${field}:`));
        ['authMode', 'planType']
          .forEach((field) => expect(accountUpdatedNotification).toContain(`${field}:`));
        [
          'rateLimits',
          'rateLimitsByLimitId',
          'rateLimitResetCredits',
        ].forEach((field) => expect(rateLimitsResponse).toContain(`${field}:`));
        [
          'totalTokens',
          'inputTokens',
          'cachedInputTokens',
          'cacheWriteInputTokens',
          'outputTokens',
          'reasoningOutputTokens',
        ].forEach((field) => expect(tokenUsageBreakdown).toContain(`${field}:`));
        client = new CodexAppServerClient({
          appVersion: '0.149.1-runtime-test',
          codexHome,
          command,
          environment,
        });

        await client.start();
        const response = await client.request<{
          account: unknown;
          requiresOpenaiAuth: unknown;
        }>('account/read', { refreshToken: false }, 30_000);

        expect(response).toEqual({ account: null, requiresOpenaiAuth: true });
      } finally {
        client?.stop();
        await removeWithRuntimeRetry(directory);
      }
    }, 30_000);
});
