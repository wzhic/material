# Codex订阅模型分析-DEV-0020-v1.0

## 1. 文档信息

| 项目 | 内容 |
| --- | --- |
| 文档 / 版本 | Codex订阅模型分析-DEV-0020 / v1.1 |
| 状态 | DRAFT；目标技术合同完整，按实际验证结果收口 |
| 日期 | 2026-08-26（2026-08-30 更新） |
| 关联需求 | [REQ-0008](../requirements/Codex订阅模型分析-REQ-0008/Codex订阅模型分析-REQ-0008-v1.0.md)、[REQ-0007](../requirements/Codex订阅接入-REQ-0007/Codex订阅接入-REQ-0007-v1.0.md)、[REQ-0005](../requirements/单素材分析-REQ-0005/单素材分析-REQ-0005-v1.0.md) |
| 关联排障 | [TRB-0017](../troubleshooting/Codex订阅模型分析-TRB-0017-v1.0.md) |
| 任务 / 分支 | APP-0027、APP-0036 / codex/req-0008-app-0036-codex-visual-frames |
| 目标平台 | macOS arm64/x64、Windows x64 |

来源 APP-0022 的 DEV-0013 不导入：当前仓库的 DEV-0013 已属于分析编排与报告预览。本文以 DEV-0020 承接订阅前置能力并定义分析接线，避免编号和事实来源冲突。

## 2. 目标与非目标

目标是在既有 AnalysisEngine 的模型端口增加一个独立 Codex subscription provider，使同一份受控分析请求可由用户显式选择 API Key 或“Codex 订阅（Beta）”执行；目录项同时声明 text/image 时，复用现有 M02 + VisualInputPreparer，把有限 JPEG 代表帧通过 App Server `localImage` 送入同一 turn，同时保持既有编排、严格 schema、报告和历史生命周期。

非目标：

- 不把 Codex SDK/App Server 暴露成 renderer 通用 RPC。
- 不复用全局 Codex CLI/IDE 登录或工作目录。
- 不发送原始视频、原始音频、原始图片、任意本地路径或远程 image URL；唯一媒体输入是当前素材的受控 JPEG 代表帧和本次匿名临时路径。
- 不支持工具、文件探索、任意网络、连续线程或 coding agent。
- 不在应用层重试、换模型或回退 API Key。
- 不将 App Server Experimental 包装为稳定生产 API。

## 3. 官方能力与成熟度

[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) 可从 Node.js 应用启动线程；[Codex App Server](https://learn.chatgpt.com/docs/app-server) 提供 account/read、account/login/start、model/list、account/rateLimits/read、thread/start、turn/start、turn/interrupt 和事件通知等产品嵌入接口。官方协议还以 `model/list.inputModalities` 声明 image 能力，并在 `turn/start.input` 定义 `localImage.path`。官方 SDK 页同时明确建议用于“coding-focused Codex threads”；Material 的素材分析属于非代码工作流。这是适用性风险而不是本设计声称的条款禁止；真实账号 smoke 与 OpenAI 产品/条款适配确认前，provider 必须保持 Beta、不作为默认/稳定来源，并保留 API Key 路由。

认证按 [Codex Authentication](https://learn.chatgpt.com/docs/auth)：

- Sign in with ChatGPT 使用订阅权益。
- API Key 使用 API 平台按量计费。
- 两者为不同 source，不共享 token、配置、错误或自动回退。

App Server、部分传输和实验方法必须按官方文档视为 Experimental。Material 界面统一使用“Codex 订阅（Beta）”。锁定 runtime 为拒绝 provider fallback 以及发送空 environment/capability 字段，当前握手需要 experimentalApi=true；只允许这些具名字段，不开放通用实验 RPC，并禁用实验外部 chatgptAuthTokens。未来企业广泛分发时设置稳定唯一的 clientInfo.name，并按官方要求联系 OpenAI 处理 known client。

实时官网与锁定 0.149.1 runtime 的 generate-ts schema 存在版本差异。发布合同以仓库锁定生成协议、固定 runtime 和真实协议测试为准；官网出现而 locked schema 尚无的字段只能作为升级候选，不能写成当前已强制能力。

## 4. 总体架构

~~~mermaid
flowchart LR
    UI[Renderer 新建分析与模型管理] -->|窄 DTO / AbortSignal| MAIN[Electron 主进程]
    MAIN --> ENG[AnalysisEngine / Runner]
    ENG --> ROUTER{显式 source}
    ROUTER --> API[既有 API Key ModelService]
    ROUTER --> CODEX[CodexSubscriptionService.complete]
    CODEX --> CLIENT[CodexAppServerClient]
    CLIENT -->|stdio JSONL| SIDE[固定 Codex App Server runtime]
    SIDE --> OPENAI[OpenAI Codex 服务]
    ENG --> SCHEMA[输出 JSON Schema + 本地语义校验]
    SCHEMA --> REPORT[报告 / 历史记录]
~~~

关键隔离：

- Renderer 只知道公开状态、掩码账号、模型摘要、限额摘要和安全错误。
- Main 持有 runtime、App Server generation、thread/turn、取消和临时目录。
- AnalysisEngine 只依赖通用 ModelCompletionRequest / ModelInvocationResult，不读取登录 token。
- 报告层只保存非秘密运行摘要，不保存 thread、token 或输入正文。

## 5. 模型来源与路由

来源采用判别联合，至少区分 apiKey 与 codexSubscription。API Key 候选继续使用 provider model ID；Codex 候选的选择值编码 sourceType、configurationId 和 `model/list.id` 目录/预设 ID，不能只用显示名或 provider slug。

Codex 固定公开配置：

| 字段 | 值 |
| --- | --- |
| configurationId | codex-subscription |
| configurationDisplayName | Codex 订阅（Beta） |
| providerId | codex-subscription |
| adapterVersion | codex-app-server@实际固定 runtime 版本 |

路由顺序：

1. Renderer 只在用户审阅配置并显式点击开始后提交当前可见的 source/config/selection ID；该值可来自全新手动选择，或下述严格匹配的重新分析草稿预填。Codex renderer 不提交 slug 或 effort override。
2. Main 按当前候选 generation 解析完整目录项，并冻结 catalog selection ID、provider requested slug 和 `defaultReasoningEffort`。
3. API Key 来源走既有服务；Codex 来源调用 CodexSubscriptionService.complete。
4. 运行中禁止重路由；失败原样归一化并结束。

锁定 `0.149.1 generate-ts --experimental` 中 `Model.id` 与 `Model.model` 是两个独立必需字段：前者是目录/预设 ID，后者是 provider 请求 slug。同 slug 可对应多个目录 ID，游标合并只按 `id` 识别同一项，不得按 slug 折叠或覆盖。`defaultReasoningEffort` 在该锁定类型中必填；V1 无 effort 选择器，必须使用所选项的默认值。缺/非法 `id`、`model`、`defaultReasoningEffort` 或同 ID 内容冲突时，整份权威目录失败关闭。`isDefault`、推荐或升级字段只用于展示，不进入运行时自动选择。

重新分析的草稿恢复只在历史记录具备现代身份字段，且 `configurationId + providerId + source + catalog preset ID` 与一个当前候选全部精确相等时预填该候选。预填必须可见，不触发运行；用户仍须在配置页审阅、显式点击开始并完成订阅额度确认。legacy 缺身份、任一字段不匹配、候选下线或目录失效时 `modelSelectionValue` 清空并提示重选；不得按 display name、历史/provider slug、同 slug 其他 preset、默认项或来源回退猜测。

## 6. 前置状态与冻结

开始 Codex 分析前必须在主进程重新验证：

- runtime 已初始化且 generation 未失效；
- 无登录中、连通性测试中或其他活动 probe；
- account/read 为已登录；
- rate limits 没有已知触限；
- model/list 当前目录包含所选 catalog ID，其 provider slug、default effort 和 text modality 合法；`inputModalities` 同时含 image 时才可启用视觉输入；
- catalog ID、provider requested slug 和 frozen effort 各自满足锁定类型与长度/字符白名单；
- AbortSignal 尚未取消。

通过当次权威 `model/list` 预检后冻结 runtime generation、account epoch、configurationId、catalogSelectionId、providerRequestedModelSlug 和 frozenReasoningEffort。当前实现没有独立 model catalog generation，因此文档不伪造该计数器；目录新鲜度由开始前实时预检保证。账号退出、换号、runtime 重启或预检发现目录项下线/改 slug/改默认 effort 会使未开始请求失败；已运行请求不迁移到新 generation。

## 7. AnalysisEngine 请求合同

Codex provider 只接受：

- configurationId 精确等于 codex-subscription；
- 请求中的 modelId 语义为当前 `model/list.id` 目录选项 ID，必须由主进程解析为同一权威项的 provider slug 和 default effort；
- format 为 json；
- thinking 为 disabled；
- 两条消息，顺序固定为 system 与 user；
- 非空文本，总长度和单条长度均有硬上限；
- maxTokens 为安全整数且处于固定区间；
- outputSchema 是可序列化对象且大小受限；
- visualInputs 缺失，或为 1～8 个当前素材代表帧；每项必须是唯一合法 evidenceId、`image/jpeg`、最长边≤1280、单帧≤1 MiB、总计≤6 MiB、非负采样时间或 null，并通过标准 Base64 与 JPEG SOI/EOI 二次验证；
- temperature 缺失或位于允许范围。

system 内容来自版本化 Material Prompt，不接受用户任意系统指令；user 文本由 evidence packet 与产品快照确定性生成；visualInputs 只在主进程内由 M02 注册 artifact 经 VisualInputPreparer 产生，renderer/IPC 不能注入路径或图像。任何额外消息、未知配置、过大 schema、不可序列化值、非法目录 ID/slug/effort、renderer effort override 或视觉批次越界在 thread/start 前返回 INVALID_INPUT。

## 8. 结构化文本与受控代表帧

本地 EvidencePacket 先完成字段、上限、证据 ID 和去路径化校验，再渲染为受控文本。V1 允许 technical facts、采样时间、OCR/ASR 文本、视觉标签、产品字段、模板和规则摘要。所选 Codex 目录项同时声明 text/image 时，AnalysisRuntime 复用 M02 `media.frame.extract` 和 VisualInputPreparer：只读取本次 invocation 注册 artifact，编码为 JPEG，再由 CodexSubscriptionService 独立复验。禁止原始视频/音频/图片、data URL、file URL、sourcePath、relocatedPath、工作区路径、凭据、其他记录和任意附件。

数据流：

~~~mermaid
flowchart TD
    M[本地素材] --> P[确定性解析]
    P --> E[EvidencePacket]
    E --> V{白名单/长度/路径扫描}
    V -->|失败| F[INVALID_INPUT，不启动 runtime]
    V -->|通过| T[结构化文本 user message]
    P --> M02[M02 受控代表帧]
    M02 --> J[JPEG 编码与双层限制校验]
    J -->|失败| F
    J --> L[匿名 localImage 临时文件]
    T --> C[Codex 单次 turn]
    L --> C
~~~

EvidencePacket 与输出均必须保留 evidenceId；模型输出只能引用输入集合内的 ID。文本正文、帧字节和临时路径不写入常规日志、renderer、报告或持久化。最多 8 个离散采样帧只补足画面语义，不代表完整视频逐帧覆盖。

## 9. 一次临时 thread 与一次 turn

每次 complete 调用执行：

1. 创建随机分析专用临时目录 `material-codex-analysis-*`。纯文本调用保持为空；视觉调用按稳定顺序写入 `representative-frame-01.jpg`～`08.jpg`，文件模式 0600，文件名不含素材名、路径、frame/evidence 原值。
2. 按当前权威目录的 catalog selection ID 解析 provider requested slug 和 frozen default effort；两者不从 renderer 接收。
3. 若视觉批次非空，再次要求当次权威目录项 `inputModalities` 含 image；随后按固定匿名名以 `wx` 写入。任何缺 image 能力、非法 Base64/JPEG/尺寸/数量/字节、写入失败或 generation 变化都在 thread/turn 前失败关闭。
4. `thread/start` 指定 `model=<provider slug>`、`config.model_reasoning_effort=<frozen effort>`、`allowProviderModelFallback=false`、ephemeral=true、本次 cwd/runtimeWorkspaceRoots、approvalPolicy=never、sandbox=read-only、空 dynamicTools/environments/selected capability roots。锁定 `ThreadStartParams` 没有独立 effort 字段，所以 thread 级 effort 必须通过 config 发送；provider 不由 renderer 或 fallback 提供，而由响应校验必须为 OpenAI。
5. 在启动 turn 前逐字段校验 `ThreadStartResponse`：thread id 合法、thread.ephemeral=true、`modelProvider === "openai"`且 thread.modelProvider 一致、`model === provider requested slug`、`reasoningEffort === frozen effort`、`cwd` 与 `runtimeWorkspaceRoots` 只指向本次分析目录、`approvalPolicy === "never"`、`multiAgentMode === "explicitRequestOnly"`、`sandbox.type === "readOnly"`、`sandbox.networkAccess === false`、`instructionSources` 为空，且可选 `activePermissionProfile` 只能是无 extends 的合法内建 profile。任一缺失/偏差先把可用的 provider returned slug 写入失败 audit，然后使当前 generation 失败关闭。
6. `turn/start` 提交一条 text input，并在视觉调用中追加 1～8 条 `{type:"localImage", path:<匿名绝对路径>}`；同时发送 `model=<同一 provider slug>`、`effort=<同一 frozen effort>`、固定 outputSchema、summary=none、同一 cwd/roots、approvalPolicy=never、readOnly + networkAccess=false。禁止 `{type:"image",url}`、data URL、localAudio、skill、mention 或其他路径。
7. 等待同一 thread/turn 的受控终态，收集最终文本、provider returned slug 与可用 token usage。
8. 在成功、失败、取消、超时、协议错误和安全错误的统一 finally 中，只按本次已解析精确目录递归删除匿名帧与目录，再移除活动上下文。

“一次 turn”指 Material 只发送一次 turn/start。App Server/runtime 可能在内部流式传输或恢复网络请求；客户端不声称只有一次 HTTP，也不因失败发送第二次 turn/start。

不得恢复旧 thread、调用 thread/list、保存 thread id 或在 schema 失败后追加“请修正 JSON”的第二 turn。

锁定 `0.149.1 generate-ts --experimental` 的 `Turn.items`、`item/started` 和 `item/completed` 共用同一严格解析器，只识别三类非工具 item：

- `userMessage`：要求有界合法 `id`、可空有界 `clientId`、非空 `content`；必须有合法 text，视觉调用只额外接受 `type=localImage` 且 path 与当前 ProbeContext 的匿名路径集合精确匹配。remote image URL、其他本地路径、localAudio、skill、mention 或未知 input 立即安全失败；校验后整项丢弃，不比较、回传或保存原文/路径；
- `reasoning`：要求有界合法 `id`，`summary` 与 `content` 都是有界字符串数组；校验后立即丢弃；
- `agentMessage`：要求有界合法 `id/text`，`phase` 仅为 null / commentary / final_answer，`memoryCitation` 必须为 null，`delivery` 仅为 null / async；只有完成生命周期中的合法 `agentMessage` 可成为最终正文候选，之后仍走 JSON/schema/语义校验。

`userMessage` 与 `reasoning` 只为协议兼容，绝不进入 renderer、报告、日志或存储。上述任一类型缺少或畸形必填字段触发 PROTOCOL_ERROR；任意非本次 `localImage`、remote image，以及 tool、command、file、web、MCP、collab 或未知 item 触发安全失败。两者都使当前 generation 失败关闭。

`ErrorNotification` 要求 `threadId`、`turnId`、合法 error 体及布尔 `willRetry`；`willRetry=true` 和 `false` 都是合法 schema。Material 不采用该字段作为继续条件，收到任一值都拒绝当前调用、结束本次 generation，不等待其声称的恢复，也不创建第二个 turn。

## 10. 文件、sandbox、工具与网络

thread 和 turn 的 cwd 都是新建分析专用目录；纯文本调用为空，视觉调用只含 1～8 个固定匿名名 JPEG。结构化证据以内联 text input 提交，原始素材、路径映射、凭据和其他证据文件不进入目录。锁定 0.149.1 的 generate-ts schema 尚不支持实时官网新文档中的 restricted access/readableRoots，因此 V1 不声称协议强制文件根，而是以新目录、精确 `localImage` allowlist、read-only、无工具和全终态删除收口。

thread/start 与 turn/start 均设置：

- approvalPolicy=never；
- read-only sandbox；
- environments=[]；
- dynamicTools=[]；
- selectedCapabilityRoots=[]；
- networkAccess=false；
- app-scoped config 以 --strict-config 启动；根级使用 pinned 0.149.1 已实测接受的 `web_search = "disabled"`、`approval_policy = "never"` 和 `sandbox_mode = "read-only"`；`[features]` 明确设置 `view_image = false`、`shell_tool = false`、`unified_exec = false`、`apps = false`、`remote_plugin = false`、`hooks = false`、`multi_agent = false`、`skill_mcp_dependency_install = false`；
- 实时官网配置键与 pinned 0.149.1 strict schema 不同：实测加入 `[tools] view_image=false` 会使 `app-server --strict-config` 在 initialize 前退出，因此生产配置不得照搬该官网新键，必须服从锁定版本可成功 initialize/account-read 的 `[features] view_image=false` 与根级 `web_search="disabled"`；
- 指令再次禁止 tools、其他 files、network、apps、hooks、memories、skills 和 sub-agents；只允许模型消费请求中明确提供的代表帧；
- apply_patch、file change 等没有已验证静态关闭键的内建能力由空 dynamicTools/capability roots、read-only/approval never 和协议监听共同收口；任意 unexpected tool event 或 server request 都使同一 generation 失败关闭。

“networkAccess=false”限制工具/沙箱网络，不阻止 runtime 自身与 OpenAI 模型端点通信。任何 server request、工具事件、文件/命令意图或未识别高风险事件触发 SECURITY_VIOLATION，当前 generation 失败关闭并 interrupt；renderer 不出现审批弹窗。

## 11. 输出 schema 与语义校验

AnalysisEngine 依据行业、媒体类型和固定规则包生成两层合同。发送给 App Server 的 outputSchema 只使用锁定 runtime 官方支持子集，例如 object、properties、required、additionalProperties、array/items、string、number、enum 与基本边界；不得发送 locked schema 不支持的 oneOf、uniqueItems 等关键字。title、summary、goalScene、dimensionAssessments、diagnoses、recommendations、fixed/dynamic tags、visual/audio/script 等更严格业务规则由本地校验层补齐。

App Server outputSchema 只是第一道约束。主进程收到最终文本后仍必须：

1. 只提取当前 turn 完成生命周期中严格合法的 `agentMessage` 最终正文候选；`userMessage` 与 `reasoning` 不参与结果拼接；
2. JSON.parse；
3. 按本地 schema 验证；
4. 验证维度完整唯一、分数边界、标签集合、evidenceId 引用、诊断与建议索引；
5. 验证通过后才交给报告层。

自由文本、Markdown 代码围栏、额外字段、未知证据、重复维度、超限数组、NaN 或缺失字段统一为 RESPONSE_INVALID；不保存部分报告，不启动修复 turn。

## 12. 取消、超时与 generation

complete 接收 AbortSignal。取消算法：

- 若开始前已 aborted，直接返回 CANCELLED，thread/start 为零。
- UI `cancelling` 只表示取消请求态，不等于 CANCELLED 终态。活动中 signal abort 或客户端超时与模型成功竞争首个受控终态，并对已知 thread 最多发送一次 turn/interrupt。
- turn/start 尚未返回时也保持同一终态；迟到的 thread/turn 通知按 generation、threadId、turnId 过滤。
- 首个受控终态胜出；CANCELLED/TIMEOUT 先确立后的成功、usage 或错误不改写结果，成功先确立后的取消请求/runtime close 也不将 succeeded 改写为 cancelled。
- finally 移除 listener、timer、activeProbe、interruptible map，并清理精确临时目录。

客户端分析截止时间与 App Server 控制请求超时分开。两者均不触发应用层自动重试。runtime 崩溃使 generation 失效；旧 generation 的请求和通知不得进入新实例。

## 13. 模型身份、usage 与审计

ModelInvocationAudit 至少记录 adapterVersion、providerId、configurationId/version、catalogSelectionId、providerRequestedModelSlug、providerReturnedModelSlug、frozenReasoningEffort、started/finished/duration、status 和安全错误码。

当前 TypeScript 字段名与业务语义的精确映射为：

| 实现字段 | 固定语义 |
| --- | --- |
| `modelId` | catalog selection ID，即 `model/list.id`；不是 provider slug |
| `providerRequestedModelId` | provider requested model slug，即所选项 `model` |
| `providerReturnedModelId` | provider returned model slug，来自锁定 runtime 响应/事件 |
| `providerReasoningEffort` | frozen reasoning effort，即所选项 `defaultReasoningEffort` |

字段名中的 `ModelId` 不允许模糊化这组区别；序列化、UI 标签和 PDF 必须按上表解释。

模型合同：

- catalogSelectionId 是用户开始时冻结的 `model/list.id`，不是 provider slug。
- providerRequestedModelSlug 来自同一目录项的 `model`；frozenReasoningEffort 来自该项的 `defaultReasoningEffort`。
- providerReturnedModelSlug 来源于 `ThreadStartResponse.model` 或明确 model reroute 事件；在转为错误前先写入 audit。
- 若 provider、requested/returned slug、frozen/returned effort、cwd/roots、approval 或 sandbox/network 任一偏差，必须同时保留已知元数据并使当前 generation 失败关闭；不得将 requested 覆盖成 returned，也不得作为自动切换继续。
- 模型目录、运行参数和 audit 都以 catalog ID + provider slug + effort 三元组为不变量；同 slug 的不同目录 ID 不可互换。

usage 只解析可信的非负安全整数。缓存命中、未命中、输入、输出和总 token 分开记录。上游未提供 usage 时数据层必须能表示 unknown/null；不能用全零断言“没有消耗”，也不在客户端换算价格、credits 或剩余额度。

AnalysisReportDraft、确认后 AnalysisRecord、历史详情与 PDF 使用同一非秘密运行摘要，保存 sourceType、providerId、configurationId/version、catalogSelectionId、providerRequestedModelSlug、providerReturnedModelSlug、frozenReasoningEffort、runtime/capability version 和 usage availability/counts。这些字段从 audit 向后传递，不由 UI 重新猜测。旧记录的 catalog/slug/effort/usage 扩展字段均为可选；历史与 PDF 显示“暂不可用”，不伪造 slug、effort 或零 usage。

## 14. IPC 与 renderer 边界

Renderer 可见：

- CodexSubscriptionState 的状态、掩码账号、planType、模型摘要、限额摘要和安全错误。
- 设备码登录当前尝试的固定验证 URL 与一次性 `userCode`，但只在当前登录 dialog 存续；只能由用户主动复制，尝试终态、取消或 dialog 关闭后立即清除。
- Analysis source 候选、稳定阶段、取消结果和报告模型摘要。

Renderer 不可见：

- token、refresh token、动态 auth URL、当前登录 dialog 之外或终态后的 `userCode`、CODEX_HOME、thread/turn 原始对象；
- App Server 原始 JSONL、server request、reasoning、prompt、证据正文、媒体/临时路径；
- shell、任意 method 名、cwd、sandbox、tools 或 experimentalApi 开关。

preload 只暴露固定方法与 DTO，逐字段重建对象；事件 unsubscribe 必须可用。IPC handler 对 sender、参数长度、枚举、ID 与错误进行校验，异常转为安全 public error。

## 15. 错误归一化

| Codex / 本地条件 | ModelApi 错误 | UI 恢复 |
| --- | --- | --- |
| 未登录、登录中、账号换代 | AUTHENTICATION_FAILED | 前往模型管理或等待登录结束 |
| 模型缺失/下线/实际模型不允许 | MODEL_NOT_AVAILABLE | 刷新目录并重新显式选择 |
| usageLimitExceeded / 已知触限 | RATE_LIMITED | 显示窗口和重置摘要，稍后手动重试 |
| 输入/envelope/schema 参数非法 | INVALID_INPUT | 修复本地生成/表单，不调用模型 |
| 输出 JSON/schema/协议非法 | RESPONSE_INVALID | 保留草稿；不得追加修复 turn |
| runtime、sidecar、工具违规 | SERVICE_UNAVAILABLE | 诊断 runtime；安全违规先停用 |
| 用户取消 | CANCELLED | 回到草稿 |
| 分析截止 | TIMEOUT | 手动重试，不自动发第二次 |
| 未分类 | UNKNOWN | 显示 correlation id，按 TRB-0017 排查 |

原始上游 message 不直接显示或入日志，避免 token、路径或 prompt 泄露。

锁定协议的 `ErrorNotification.willRetry` 只做布尔 schema 校验，不改变错误归一化：无论为 `true` 或 `false`，都映射为当前调用的失败终态；Material 不等候或消费后续重试结果，不发第二个 `turn/start`。

## 16. runtime、认证与打包

- @openai/codex-sdk 与随附 runtime 使用精确锁定版本，不从 PATH 或全局安装兜底。
- 启动前校验平台、架构、资源路径、可执行位和版本握手；不一致失败关闭。
- 使用 Material 专属 CODEX_HOME 和独立 keyring service/account 名。
- 浏览器登录和设备码登录由主进程控制；renderer 只接收最小公开信息。
- 退出只作用于 app-scoped 会话，不读取、复制或退出用户全局 CLI/IDE。
- macOS runtime 放 ASAR 外并进入签名/公证；Windows 进入安装资源并验证 Credential Manager/DPAPI、SmartScreen 与卸载/回退。
- 开发机可启动不等于打包可启动，未签名包不等于分发包。

## 17. 测试策略

### 17.1 自动化

- Request/envelope/schema 边界与恶意路径/媒体样本；代表帧数量、尺寸、标准 Base64、JPEG SOI/EOI、单帧/总字节、重复 evidenceId 全部正负向覆盖。
- 目录 ready/limited/换号/下线与显式来源路由；`id`/`model`/`defaultReasoningEffort` 缺失或非法 fail-close，同 slug 多 ID 不折叠，同 ID 冲突拒绝。
- 一次 thread/start、一次 turn/start、ephemeral、catalog selection ID 解析、provider slug + frozen default effort 在 thread config/turn 中一致、`allowProviderModelFallback=false`；纯文本 cwd 为空，视觉 cwd 只含匿名 JPEG，turn input 为一条 text 加受控 `localImage`。
- `ThreadStartResponse` 的 modelProvider=openai、requested/returned slug、reasoningEffort、cwd/roots、approval never、readOnly + network false 全字段正/负向测试；任一偏差失败关闭且失败 audit 保留返回 slug。
- app-scoped strict config、sandbox、tools、network、approval 参数快照，以及意外工具/server request 同 generation 失败关闭。
- `Turn.items` 与 item 生命周期三类白名单：合法 `userMessage`/`reasoning` 校验后立即丢弃、合法 `agentMessage` 是唯一最终正文候选；本次精确 `localImage` 允许协议回显，其他路径/remote image 失败关闭；三类必填字段畸形为协议失败，tool/command/file/web/MCP/collab/未知 item 为安全失败，均不得进入 renderer/报告/日志/存储。
- `ErrorNotification.willRetry=true/false` 均通过通知 schema，但两者都终止本次 generation；断言无等待重试、无第二 turn、无模型或 API Key fallback。
- pinned runtime 正向证明 `[features] view_image=false`、根级 `web_search="disabled"`、`shell_tool=false`、`unified_exec=false` 可 initialize/account-read；负向保留 `[tools] view_image=false` 被 strict schema 拒绝的兼容证据，防止误抄实时官网键。
- 取消前、thread 后、turn pending、迟到成功、runtime close 竞态。
- 视觉临时目录在成功、失败、取消、超时、协议错误和安全错误后均删除；文件名、renderer、audit、SQLite、报告、PDF、日志无 evidenceId、路径或帧字节。
- 无应用层重试、无换目录预设/slug/effort、无 API Key fallback。
- catalog selection ID、provider requested/returned slug、frozen effort 和 usage/unknown 在 audit、报告、记录、历史详情与 PDF 的序列化/展示；旧记录缺字段兼容。
- IPC 白名单、错误脱敏、日志与存储秘密扫描。
- API Key 回归和旧报告读取。

### 17.2 分层环境

| 环境 | 需要的证据 |
| --- | --- |
| mock | RPC 次数、参数、事件、竞态和错误映射 |
| 固定 runtime 未登录 | initialize、版本、架构、未登录 account/read、安全退出；`generate-ts --experimental` 明确包含 `inputModalities=image` 与 `UserInput.localImage` |
| 真实订阅开发环境 | account/model/rate-limit、纯文本与视觉各一次受限分析、catalog/requested/returned/effort、代表帧数量/覆盖局限与 usage 摘要；另行记录非代码工作流的产品/条款适配确认状态 |
| macOS 签名安装包 | runtime、Keychain、登录/退出、全局会话隔离、真实 smoke |
| Windows 签名安装包 | runtime、Credential Manager、安装/卸载、全局会话隔离、真实 smoke |

自动化默认不得登录或消耗用户订阅。真实 smoke 必须由用户或授权测试负责人在应用界面主动发起。

视觉真实订阅 smoke 除成功结果外还必须证明：本次只有一个 ephemeral thread/turn，tool call 与 unexpected server request 计数均为 0，原始视频没有进入请求，只有匿名代表帧 `localImage`，终态后临时目录不存在。只检查最终文本而不检查事件流和清理不算安全证据。

## 18. 已知证据边界与实现收口检查

文档与实现评审时逐项确认：

- 当前已实际通过 pinned `0.149.1 generate-ts --experimental` 合同和 strict App Server 未登录启动/account-read 验证；这只是锁定 runtime 协议证据。
- 既有真实 ChatGPT 订阅已完成纯文本结构化分析与游戏视频的文本证据链路验证，但 APP-0036 的视觉 `localImage` 真实订阅 smoke 尚未执行；OpenAI/DeepSeek API Key live credential smoke 也无当前凭据证据。自动化与未登录 runtime 不能被写成“真实视觉账号已调通”。
- 静态 P-CS-01/P-CS-02 只证明设置入口，不能记为分析成功。
- Mock App Server 只证明客户端合同。
- 未登录 runtime 只证明 sidecar 能启动。
- 开发环境真实 smoke 不能替代签名安装包。
- 单平台结果不能替代另一平台。
- 返回全零 usage 若上游未提供，必须与真实零区分后才能满足 REQ-0008。
- provider requested/returned slug 差异必须在返回失败前进入 audit；报告策略不得静默覆盖，也不得继续当前 generation。
- catalog selection ID、provider requested/returned slug 和 frozen effort 必须纵向贯通 audit/报告/确认记录/历史/PDF；旧记录可缺，但不得用当前目录回填。
- 官方 SDK 主要定位是 coding-focused threads；非代码素材分析在真实账号 smoke 和 OpenAI 产品/条款适配确认前只能作为 Beta，不设默认/稳定，API Key 保留；本文不声称官方条款禁止。
- 所有 required validations 必须由主任务实际运行；SKIP、取消、超时或未运行不算通过。

## 19. 兼容、迁移与回退

不迁移或解密 API Key，不改变 API Key vault schema。候选增加 sourceType 后，旧草稿缺失该字段时不得猜测来源；要求用户重新选择。同理，旧草稿不能用仅有 provider slug 匹配当前 catalog ID/default effort。报告与记录 schema 以向后兼容方式增加可空 catalog/slug/effort/usage 字段；旧报告仍可离线读取，PDF 不伪造缺失值。

关闭 Codex provider 时：

1. 停止接受新订阅分析；
2. interrupt 当前受控 turn；
3. 隐藏/禁用订阅候选并保留明确 Beta 不可用提示；
4. 不删除账号、API Key、报告或全局 Codex 状态；
5. 恢复旧客户端后 API Key 路径继续可用。

runtime 升级、移除 Beta、将 Codex 设为默认/稳定来源、修改数据外发或开放工具均必须另立需求和安全验证。将 Codex 从 Beta 提升前还必须完成真实账号 smoke 和非代码工作流的 OpenAI 产品/条款适配确认；不通过时关闭 Codex 候选并保留 API Key。

## 20. 官方来源与变更历史

官方来源：

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
- [Codex Authentication](https://learn.chatgpt.com/docs/auth)
- [Codex Pricing](https://learn.chatgpt.com/docs/pricing)
- [Feature maturity](https://learn.chatgpt.com/docs/feature-maturity)
- [Enterprise access tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens)

| 版本 | 日期 | 变更摘要 | 任务 |
| --- | --- | --- | --- |
| v1.1 | 2026-08-30 | 增加 image 能力门禁、M02/VisualInputPreparer 双层代表帧边界、JPEG/Base64/数量/尺寸/字节复验、匿名 `localImage`、全终态清理、精确回显 allowlist、原视频不上传及视觉协议/真实 smoke 测试合同 | APP-0036 |
| v1.0 | 2026-08-26 | 新增订阅分析 provider、catalog ID/provider slug/default effort 冻结、同 slug 多预设、ThreadStartResponse fail-close、显式路由、结构化证据、一次 ephemeral thread/turn、严格 schema、取消 generation、无工具网络、audit/报告/记录/PDF 模型/usage 贯通、IPC/打包/证据分级与回退设计 | APP-0027 |
