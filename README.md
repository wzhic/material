# Material

面向广告素材制作者与广告优化师的跨平台素材制作项目。

项目规模为 `M`，采用一个 monorepo 管理三个独立发布单元：共享代码的 macOS/Windows 客户端，以及统一后端。客户端业务功能一致，但两个平台分别构建、验收、发布和回退；后端独立发布。

## 当前约束

- 后端不保存账号数据。
- 个人数据保存在客户端本地 SQLite，登录凭据使用系统安全存储。
- 当前不走应用商店，但保留以后接入签名、公证和商店发布的能力。
- 自动化不会发布广告，也不会调整广告预算。

## 工作方式

治理采用最小交互模式：清晰需求就是普通可逆工作的范围决定。Codex 在当前任务范围内可自动联网、编辑、安装常规依赖、测试、返工、提交、推送功能分支、准备 PR，并可把工作拆给有记录的子 Agent；用户只在验证豁免、破坏性或不可逆操作、敏感数据或实质安全/成本/不兼容迁移，以及最终合并、部署、发布时做决定。GitHub Actions 直接展示 CI 结果，由 Codex 核对并报告，不要求用户发送 Run 链接、提供同步 Token、抄写结果或亲自承担日常 CI 核对。

主要入口：

- `python3 tools/governance/taskctl.py current --json`：查看当前任务。
- `python3 tools/governance/reconcile.py session --json`：核对仓库状态。
- `python3 tools/governance/projectctl.py init`：用官方生成器完成应用框架和依赖初始化。

子 Agent 只记录名称、目的、状态、时间和结果摘要，不记录提示词、内部推理或秘密；规则见 [子任务协作](docs/development/子任务协作-DEV-0002-v1.0.md)。

应用初始化默认采用 Electron Forge + TypeScript 构建共享桌面客户端，采用 uv + FastAPI 构建统一后端。生成器产生依赖清单和锁文件，仓库不手工仿造脚手架。

详细需求、开发、运维和排障记录见 [docs/README.md](docs/README.md)。历史 G0 文档保留用于审计，不再代表普通任务需要用户逐步操作。
