# Codex订阅模型分析-TRB-0017-v1.0

## 1. 文档信息

| 项目 | 内容 |
| --- | --- |
| 文档 / 版本 | Codex订阅模型分析-TRB-0017 / v1.1 |
| 日期 / 状态 | 2026-08-30 / DRAFT |
| 适用范围 | “Codex 订阅（Beta）”登录、目录、限额、文本/代表帧分析、取消、报告、runtime 与双平台打包 |
| 关联需求 | [REQ-0008](../requirements/Codex订阅模型分析-REQ-0008/Codex订阅模型分析-REQ-0008-v1.0.md)、[REQ-0007](../requirements/Codex订阅接入-REQ-0007/Codex订阅接入-REQ-0007-v1.0.md) |
| 关联设计 | [DEV-0020](../development/Codex订阅模型分析-DEV-0020-v1.0.md) |
| 关联任务 | APP-0027、APP-0036 |

来源 APP-0022 的 TRB-0010 不导入：当前仓库 TRB-0010 已用于分析编排与报告预览。本文用 TRB-0017 统一处理 Codex 前置接入和分析调用，避免编号冲突。

## 2. 安全规则

排障不得要求、复制、截图、上传或记录：

- ChatGPT token、refresh token、cookie、完整/动态 auth URL 或当前一次性设备码 `userCode`；设备码只可由用户在当前登录 dialog 查看或主动复制，不作为排障材料；
- API Key、系统凭据导出、auth.json 或 Material 专属 CODEX_HOME 内容；
- 原始媒体、代表帧字节/临时路径、缩略图、素材/产品库/仓库/用户目录路径；
- 完整 prompt、结构化证据正文、App Server 原始 JSONL 或 reasoning；
- 用户完整邮箱、组织名称或与问题无关的账号信息。

只收集：公开错误码、掩码账号、planType、状态、catalog selection ID、provider requested/returned slug、frozen reasoning effort、代表帧数量与覆盖局限、runtime/客户端版本、非秘密 correlation id、平台/架构、耗时和 usage 是否存在。不得收集帧内容或路径。怀疑秘密泄露时先停止复现，按第 14 章处理。

## 3. 先确定证据层级

在排障结论开头标注层级，不能越级：

| 层级 | 已运行 | 允许结论 |
| --- | --- | --- |
| T1 | 单元或 mock App Server | 客户端状态/RPC 合同通过 |
| T2 | 固定 runtime 未登录启动 | runtime 版本、架构、initialize 可用 |
| T3 | 开发环境真实订阅 smoke | 指定账号、模型、当时限额下真实调用成功/失败 |
| T4 | 签名安装包真实 smoke | 该平台该安装包可用 |
| T5 | macOS 与 Windows 分别通过 | 双平台证据完成 |

静态 P-CS-01/P-CS-02 只属于布局参考，不属于任何真实调用层级。一个真实账号成功不能证明所有套餐、模型、地区或未来限额。

## 4. 最小诊断顺序

1. 记录客户端版本、runtime 版本、平台、架构、签名/开发包、时间和 correlation id。
2. 确认来源确实显示“Codex 订阅（Beta）”，不要把 API Key 错误归入订阅。
3. 在模型管理读取公开状态：unavailable、signedOut、loginPending、ready、limited、testing 或 error。
4. 确认网络可达 OpenAI 登录与服务；不要用工具网络开关判断模型端点离线。
5. 手动刷新账号、模型和限额；不得循环或脚本化消耗订阅。
6. 确认新建分析显式选中的 source/config/catalog selection ID 与目录一致，并从权威目录核对 provider slug 和 default effort；不用 slug 反推目录 ID。
7. 用 mock 或受控真实 smoke 复现一次；视觉故障只记录代表帧计数/限制结果，不复制图片或路径，不要为了“偶现”自动重试。
8. 分别核对 thread/start、turn/start、interrupt 次数和受控终态。
9. 检查 audit/报告/记录/PDF 的 catalog selection ID、provider requested/returned slug、frozen effort、usage 或 unknown、错误码和日志脱敏。
10. 只有目标层级需要时才进入签名安装包和另一操作系统验证。

## 5. 状态与入口问题

| 现象 | 常见原因 | 安全检查 | 恢复 |
| --- | --- | --- | --- |
| 新建分析没有 Codex 候选 | 未登录、目录未加载、非文本项、缺 `id`/`model`/`defaultReasoningEffort`、limited、目录变更 | 查看公开状态和 model/list 摘要，不看 token | 前往模型管理登录/刷新，重新显式选择目录项；不手填 slug/effort |
| 入口显示组件不可用 | runtime 缺失、版本/架构错、握手失败 | 核对打包资源、版本、执行位和安全错误 | 修复包或回退，不从 PATH 找全局 CLI |
| 一直未登录 | 登录取消、回调/设备码失败、组织策略 | 只看 loginId 状态与公开错误 | 取消旧登录后手动重试；不导入全局 auth |
| ready 后突然清空 | 账号 epoch 变化、退出、权威预检发现目录项下线、runtime generation 失效 | 对照事件时间、account epoch、runtime generation 与最新 `model/list`；不查找实现中没有的独立 catalog generation | 重新刷新并显式选择，不静默替换 |
| testing 时不能开始分析 | 连通测试与业务分析互斥 | 查看 active probe 类型 | 等测试结束或取消测试 |
| API Key 也不能用 | 独立 API Key 问题或组合回归 | 按 TRB-0007 排查，确认 Codex 未改 Key | 修复 API Key 路径；Codex 不是自动 fallback |

## 6. 登录、账号与限额

### 6.1 AUTHENTICATION_FAILED

- signedOut：使用应用内浏览器或设备码登录。
- loginPending：等待、取消或完成当前登录；不得并发第二登录。
- 已显示 ready 但分析失败：可能账号 epoch 在预检时变化，刷新账号和模型后重新显式选择。
- 组织账号：席位、管理员策略、地区和计划可能限制 Codex；Material 不能绕过。

不得复制全局 Codex CLI/IDE token、auth.json 或使用 experimental chatgptAuthTokens 注入用户凭据。

### 6.2 RATE_LIMITED

- 查看服务返回的 primary/secondary window、usedPercent、resetsAt 和 rateLimitReachedType。
- 缺失字段显示“暂不可用”；不要解释为零、无限、免费或永久触限。
- 等待已知重置时间后由用户手动刷新；不后台轮询，不自动换模型/API Key。
- reset credits 只展示服务返回摘要，不在客户端购买、兑换或推断价格。

### 6.3 离线

保留素材和表单草稿，禁用订阅开始。网络恢复后手动刷新账号、目录与限额。历史报告和本地解析应仍可用。

## 7. 模型目录与身份问题

MODEL_NOT_AVAILABLE 可能来自：

- catalog selection ID 已从最新 model/list 消失或被隐藏；
- 所选目录项不是文本输入，或缺/含非法 `id`、`model` slug、`defaultReasoningEffort`；
- 视觉分析所选目录项未同时声明 image，或目录刷新后 image 能力消失；
- 游标合并误按 provider slug 去重，使共享 slug 的多个预设互相覆盖；
- 账号切换后目录不同；
- thread/start 返回的 provider/model/reasoning effort 与冻结值不同；
- `ThreadStartResponse` 的 cwd/roots、approvalPolicy、readOnly 或 networkAccess 与请求边界不同；
- model/rerouted 事件指向其他模型。

诊断必须同时记录 catalogSelectionId、providerRequestedModelSlug、providerReturnedModelSlug 和 frozenReasoningEffort。不得只显示最后一个 slug，也不得把 isDefault/recommended/upgrade 项、其他同 slug 预设或其他 effort 自动替换为新请求。

恢复：

1. 手动刷新 model/list。
2. 清空旧选择。
3. 由用户重新显式选择目录 ID；V1 不提供 effort 切换。
4. 确认 `thread/start` 发送 provider slug、`config.model_reasoning_effort=<frozen effort>` 和 `allowProviderModelFallback=false`；`turn/start` 发同一 slug + effort；provider 以响应 `modelProvider=openai` 校验确认。
5. 逐字段核对 `ThreadStartResponse` 的 provider、slug、reasoningEffort、cwd/roots、approval never、readOnly + network false；任一偏差或 `model/rerouted` 都必须使当前 generation 失败关闭，并在失败 audit 保留已知返回 slug。
6. 视觉调用只核对公开的 image capability 与匿名帧计数；不要抄录 `localImage.path`。无 image 能力时正确行为是纯文本模式或启动前失败，而不是上传原视频或改用 remote URL。

从历史重新分析时，模型可见预填本身不是自动选择故障：现代记录只有在 `configurationId + providerId + source + catalog preset ID` 与当前候选四元精确匹配时才允许预填，且不会自动运行；用户仍须审阅、显式点击开始并完成额度确认。若 legacy、任一字段不匹配、目录项下线却仍被预填，或系统按 display name/provider slug/同 slug 其他 preset 猜测，则按路由错误处理；正确行为是清空并要求重新选择，绝不回退。

## 8. 启动、运行与输出失败

| 错误 | 可能阶段 | 检查 | 恢复 |
| --- | --- | --- | --- |
| INVALID_INPUT | thread/start 前 | configuration、消息数量/角色、schema 大小、模型 ID、EvidencePacket；视觉时核对帧数、尺寸、Base64、JPEG、单帧/总字节和 evidenceId，不打印内容 | 修复本地请求生成；不重试上游 |
| MODEL_NOT_AVAILABLE | preflight | 所选目录项下线，或视觉批次存在但当前项无 image capability | 刷新目录并由用户重新选择；不上传原视频、不自动换模型 |
| SERVICE_UNAVAILABLE | runtime/preflight/thread | sidecar generation、版本、server request、工具违规、进程退出 | 停止当前分析，修复 runtime 或安全条件 |
| RESPONSE_INVALID | thread/turn/输出 | JSONL 协议、ephemeral、ThreadStartResponse provider/slug/effort/cwd/roots/approval/sandbox、最终 JSON/schema/证据引用 | 保留草稿；不得追加修复 turn 或更换预设/slug/effort |
| UNKNOWN | 任意 | correlation id、阶段、版本和脱敏错误类别 | 最小复现；不要展示原始上游 message |

若输出可 JSON.parse 但本地语义失败，仍属于 RESPONSE_INVALID。不要手工编辑结果后保存，也不要发第二个 turn 要求修正。

排查 `Turn.items`、`item/started` 或 `item/completed` 时先按 pinned `0.149.1 generate-ts --experimental` 区分：

- 严格合法的 `userMessage` 与 `reasoning` 是协议兼容 item，不是工具安全违规；视觉调用只允许与当前 ProbeContext 匿名帧集合精确一致的 `localImage.path`。主进程应立即丢弃整个 item，renderer、报告、日志、存储命中数都必须为 0；
- 严格合法的 `agentMessage` 是唯一可作为最终正文候选的 item，仍须通过最终 JSON/schema/语义校验；
- 三类允许 item 的必填字段、类型或长度畸形属于协议失败；其他 `localImage`、remote image、tool/command/file/web/MCP/collab 或未知 item 属安全失败。两者都应结束当前 generation，不得保留部分结果。

`ErrorNotification.willRetry=true` 与 `false` 都是合法通知形状；不要把 `true` 误诊为畸形协议，也不要因此等待或续跑。Material 对任一值都应终止本次调用，且 `turn/start` 总数仍为 1；出现第二 turn 是客户端缺陷。

## 9. 取消、超时与迟到结果

正确时序：

~~~mermaid
sequenceDiagram
    participant UI
    participant Main
    participant AppServer
    UI->>Main: abort 当前 analysis generation
    Main->>Main: 记录 cancel requested（UI cancelling）
    Main->>AppServer: turn/interrupt 最多一次
    AppServer-->>Main: completed/cancelled/error 竞争到达
    Main->>Main: 首个受控终态胜出
    Main-->>UI: 单一 succeeded/CANCELLED/TIMEOUT/失败终态
~~~

检查项：

- 确认只有一个 thread/start、一个 turn/start。
- threadId 尚未返回时取消，也不能补发第二个 turn。
- turnId 迟到时 interrupt 仍最多一次。
- `cancelling` 只是取消请求态，不是 CANCELLED 终态。CANCELLED/TIMEOUT 先确立时，迟到成功不能生成报告；模型成功已先确立时，后到取消请求不得把 succeeded 改写为 cancelled。
- 临时目录必须按精确路径清理；视觉调用在成功、失败、取消、超时和安全/协议终态后均不得残留 `representative-frame-NN.jpg`。禁止扩大删除目标。

如果取消一直转圈，先核对 renderer 是否收到单一终态，再核对 AbortSignal、active probe、generation 和 runtime close；不要让用户重复点击造成多次请求。

## 10. 文件、工具或网络安全违规

触发 SECURITY_VIOLATION / SERVICE_UNAVAILABLE 的信号包括：

- App Server 请求批准 shell、文件写入或目录扩权；
- 模型尝试调用 MCP、web search、network tool、skills、hooks、memory 或子 Agent；
- runtime workspace roots/cwd 不再等于本次分析专用临时目录，或目录出现匿名代表帧以外的文件；
- input/日志/输出出现用户素材路径、非本次 `localImage`、remote image、原始媒体字节或凭据；
- experimental server request 不在固定拒绝列表内。

严格合法并被立即丢弃的 `userMessage` / `reasoning` item 本身不是本节的安全违规；视觉调用中精确匹配本次匿名路径的 `localImage` 也只是该 `userMessage` 的允许输入回显。若原文、路径或帧字节出现在 renderer、报告、日志或存储，则按数据泄露处理。只有 `agentMessage` 可进入最终正文校验。

动作：

1. 立即取消当前 turn 并使 generation 失效。
2. 禁止保存模型结果或继续自动重试。
3. 保存不含正文的版本、阶段、方法类别、correlation id 和时间。
4. 检查分析专用 cwd（纯文本为空，视觉仅含匿名 JPEG）、sandbox readOnly、networkAccess=false、approval never、空 tools/environments/capabilities，以及 app-scoped strict config 的 `[features] view_image=false/shell_tool=false/unified_exec=false` 与根级 `web_search="disabled"`。pinned 0.149.1 会拒绝实时官网新式 `[tools] view_image=false`，排障时不得照抄该键；锁定协议没有 readableRoots 字段时也不得伪造该保护。`view_image=false` 关闭工具，不等于禁止显式 `localImage` 用户输入。
5. 按第 14 章判断是否存在真实泄露；若有，停止分发和真实 smoke。

注意：networkAccess=false 只表示无工具网络，模型传输本身需要连接 OpenAI；不要把正常模型连接误报为违规。

## 11. catalog / provider model / effort 与 usage

报告/审计至少核对：

- sourceType=codexSubscription；
- catalogSelectionId 为用户冻结的 `model/list.id`，不是 provider slug；
- providerRequestedModelSlug 来自所选目录项 `model`；
- providerReturnedModelSlug 来自 runtime；
- frozenReasoningEffort 来自所选目录项 `defaultReasoningEffort`；
- adapter/runtime/capability 版本；
- status、duration、错误码；
- usage 的输入、缓存命中/未命中、输出和总 token，或明确 unknown。

若 provider requested 与 returned slug 不同，或 runtime 返回 effort 与 frozen effort 不同：

- 不覆盖 catalog ID、requested slug 或 frozen effort；
- 当前安全策略必须失败关闭，但失败 audit 仍保留 catalog ID、两个 slug 和 frozen effort；
- 不把偏差解释为自动 reroute，不创建第二 turn，不换其他同 slug 预设/模型/effort；未来若改策略必须重新立项验收。

新记录的 audit、报告、确认记录、历史详情与 PDF 必须使用同一运行摘要；任一层丢 catalog/slug/effort 都是贯通故障。旧记录可缺这些字段，应显示“暂不可用”，不得用当前目录回填。

若 runtime 未发送 tokenUsage：

- 不应以全零解释为没有消耗；
- usage availability 必须为 unknown/null，各计数不得伪造为 0；只有 runtime 明确返回计数且可校验时才标为 available；
- 不从 token 数换算价格、credits 或剩余次数。

## 12. runtime 与打包

### 12.1 开发环境能启动、安装包不能启动

检查：

- 固定 @openai/codex-sdk/runtime 版本是否在包内；
- 平台和架构是否匹配；
- ASAR 外路径、执行位、签名/公证或 Windows 资源路径；
- App Server initialize 和 clientInfo；
- 应用专属 CODEX_HOME/keyring 是否可写；
- 是否误从 PATH 找到开发机全局 Codex。

修复必须针对打包配置；禁止把全局 CLI 路径作为 fallback。

### 12.2 版本/协议不匹配

记录客户端期望版本与实际握手版本。实时官网与锁定 0.149.1 generate-ts schema 可能不同；诊断与发布以锁定生成协议和 runtime 实测为准。固定 runtime 升级必须独立任务验证账号、目录、限额、thread/turn、事件、experimental 字段、outputSchema 支持子集、取消、安全、打包和双平台；不要只改版本字符串。

### 12.3 系统凭据

macOS 核对 Keychain，Windows 核对 Credential Manager/DPAPI。退出 Material 前后分别验证全局 Codex CLI/IDE 会话；只测试应用专属账号，绝不导出 token。

## 13. 真实订阅 smoke

真实 smoke 由用户或授权测试负责人主动执行，每次只运行一个受限样本：

1. 记录平台、包/签名状态、客户端和 runtime 版本。
2. 在 Material 专属会话登录测试账号。
3. 读取掩码 account/plan、model/list、rate limits。
4. 显式选择一个可见文本 catalog ID；视觉 smoke 还要求该项声明 image。核对 provider slug 和 default effort；同 slug 多预设不折叠。
5. 确认会消耗额度；纯文本只外发结构化文本，视觉还外发最多 8 个受控代表帧且不上传原始视频。
6. 运行一次分析，核对一个 ephemeral thread、一个 turn、tool call 与 unexpected server request 计数均为 0，并确认无重试；视觉还须核对匿名帧计数与终态删除。
7. 记录 catalog selection ID、provider requested/returned slug、frozen effort、代表帧数/覆盖局限、usage 或缺失、结果和时间；不得记录帧或路径。
8. 退出应用专属会话并确认全局 CLI/IDE 会话未变化。
9. 单独记录非代码素材分析的 OpenAI 产品/条款适配确认是否完成；官方 SDK 主要定位是 coding-focused threads，本指南不把该定位误写为条款禁止。

### 13.1 2026-08-26 macOS 开发环境实测

| 项目 | 结果 |
|---|---|
| 平台与包状态 | macOS arm64 / Darwin 25.5.0；Electron Forge 开发环境，未签名、未公证，不作为安装包证据 |
| 客户端与 runtime | Material Desktop 1.0.0；锁定 Codex runtime 0.149.1 |
| 登录与目录 | Material 专属 ChatGPT 会话就绪；账号标识与套餐不写入文档；可见文本目录和限额预检通过 |
| 显式模型 | catalog selection ID `gpt-5.6-sol`；provider requested/returned slug 均为 `gpt-5.6-sol`；冻结 default effort 为 `low` |
| 输入边界 | 固定合成 JSON 指令；没有素材、路径、原始图片、视频或音频；明确会消耗订阅额度 |
| 运行边界 | 1 个 ephemeral thread、1 个 turn；read-only、network false、approval never；tool call、unexpected server request、重试、模型切换均为 0 |
| 输出与用量 | 固定结构化结果校验通过；收到 token usage 通知，但连接测试结果不持久化 token 明细，记为 unavailable 而非 0 |
| 结论与时间 | 2026-08-26 19:47（Asia/Shanghai）用户确认客户端“调用成功”；直接等价烟测也得到 completed 且只有 agentMessage |
| 证据边界 | 仅证明当前账号、当前模型、当前未签名 macOS 开发环境；不能复制为 Windows、签名包、公证包或其他套餐证据 |

### 13.2 代表帧视觉 smoke（APP-0036 待执行）

自动化和未登录 runtime 只能证明 `inputModalities=image`、`UserInput.localImage`、客户端校验与清理合同，不能证明真实订阅视觉调用已调通。由用户授权执行时必须选一份可人工核对的游戏素材，并记录以下非秘密事实：目录项声明 text/image、代表帧数量、输出是否命中画面可见事实、一次 thread/turn、无 tool/server request、原视频未进入请求、终态后匿名帧目录已删除。不得记录素材绝对路径、帧图、帧 Base64 或 `localImage.path`。未执行前结论必须写“真实视觉 smoke 待验证”。

同一结果不得复制成 macOS/Windows 两个平台证据。未签名开发包不得标为签名安装包通过。真实账号 smoke 或适配确认任一未完成时，Codex 仍仅能标 Beta，不设默认/稳定来源，API Key 必须可用。

## 14. 隐私或秘密泄露响应

若日志、报告、持久化、临时目录、崩溃信息或当前登录 dialog 之外的 renderer/IPC 出现 token、设备码 `userCode`、动态 auth URL、API Key、路径、原始媒体或证据正文，或设备码尝试终态后 DOM 仍残留 `userCode`：

1. 立即停止真实账号测试、分发和相关日志上传。
2. 保留最小非秘密事实，不继续复制敏感内容。
3. 让账号所有者通过官方入口撤销/退出受影响会话或轮换 Key；Material 不代存新凭据。
4. 确定泄露边界：来源、进程、文件、时间、平台、是否离开本机。
5. 修复后运行秘密扫描、IPC/日志负向测试和全新专用账号 smoke。
6. 未完成影响评估前不得宣称安全问题已解决。

删除临时文件只使用本次已解析的精确目录，禁止对主目录、workspace root、通配符或未解析变量递归删除。

## 15. 修复后验证清单

- 原故障在同一层级可稳定复现，修复后消失。
- API Key 模型新增、刷新、显式分析和错误仍通过。
- Codex 候选仍要求 ready + 当前文本目录 + 非 limited；`id`/`model`/`defaultReasoningEffort` 必需，同 slug 多 ID 不折叠；只有 image modality 项标记视觉。
- 一次 thread/start、一次 turn/start；thread config 和 turn 的 provider slug/frozen effort 一致，`allowProviderModelFallback=false`，无应用层重试/回退。
- `ThreadStartResponse` 逐字段验证 provider=openai、slug、effort、cwd/roots、approval never、readOnly/network false、空 instruction sources 与受控 profile；偏差失败 audit 保留 returned slug。
- `Turn.items` 与 item 通知只接受严格合法的 `userMessage`/`reasoning`/`agentMessage`；本次精确 `localImage` 可回显，其他路径/remote image 失败关闭；前两类立即丢弃且四类禁止位置零命中，只有 `agentMessage` 可作最终正文；三类畸形及 tool/command/file/web/MCP/collab/未知 item 均失败关闭。
- `ErrorNotification.willRetry=true/false` 都终止本次 generation，且没有等待重试、第二 turn、换模型或 API Key fallback。
- 取消/超时最多一次 interrupt，迟到结果丢弃。
- 分析专用 cwd 纯文本时为空、视觉时只含匿名代表帧；read-only、approval never、pinned strict config 的 `[features] view_image/shell_tool/unified_exec=false` 与根级 `web_search="disabled"` 经 initialize/account-read 实测、事件流 tool/unexpected server request 计数均为 0；不声称 locked schema 尚无的 `[tools]` 或 readableRoots 强制。
- 视觉批次数量/尺寸/Base64/JPEG/单帧/总字节和 evidenceId 复验通过；原始视频/音频/素材路径不进入请求，所有终态临时帧删除；输出严格 schema，未知 evidenceId 拒绝。
- catalog selection ID、provider requested/returned slug、frozen effort 与 usage/unknown 在 audit/报告/记录/PDF 不被覆盖；旧记录可缺且不回填。
- Renderer、日志、报告、存储和临时目录秘密扫描通过。
- 真实订阅、签名包和双平台仅在实际执行后分别更新结论。
- 非代码工作流的 OpenAI 产品/条款适配未确认时，Codex 仍仅 Beta、不默认/不标稳定，API Key 通路保留；不把 coding-focused 定位夸大为条款禁止。

验证失败、SKIP、超时或未运行仍是未完成；不得通过降低断言、删除门禁或改 mock 掩盖。

## 16. 回退

若 Codex 分析不安全或不稳定：

1. 禁止新建 Codex 分析并清楚展示 Beta 暂不可用。
2. interrupt 当前 turn，丢弃迟到结果。
3. 保留用户草稿、历史报告、应用专属登录和 API Key 配置。
4. 不自动将草稿切到 API Key；用户恢复后自行显式选择。
5. 回退客户端/runtime/适配器时保持旧报告可读。
6. 最终发布回退、移除 Beta 或 destructive cleanup 需产品负责人决定。

若真实账号 smoke 或 OpenAI 产品/条款适配确认未通过，按同一回退路径禁用 Codex 新候选，但不删除 API Key 或已保存历史。该结论只表示当前不具备发布适配证据，不引申为官方条款禁止。

## 17. 官方来源

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
- [Codex Authentication](https://learn.chatgpt.com/docs/auth)
- [Codex Pricing](https://learn.chatgpt.com/docs/pricing)
- [Feature maturity](https://learn.chatgpt.com/docs/feature-maturity)
- [Enterprise access tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens)

## 18. 变更历史

| 版本 | 日期 | 变更摘要 | 任务 |
| --- | --- | --- | --- |
| v1.1 | 2026-08-30 | 增加 image 能力、受控代表帧、`localImage`、匿名临时目录、全终态清理、原视频不上传、路径/帧隐私响应和真实视觉 smoke 排障合同 | APP-0036 |
| v1.0 | 2026-08-26 | 新增订阅分析入口/状态、登录限额、catalog ID/provider slug/default effort 冻结与同 slug 多预设、ThreadStartResponse fail-close、一次 thread/turn、取消超时、安全违规、结构化输出、audit/报告/记录/PDF 贯通、usage、runtime 打包、真实 smoke、非代码适配性、隐私响应与回退排障 | APP-0027 |
