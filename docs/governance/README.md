# 治理文档

本目录说明任务、审核、核对、假设、验证和豁免政策；机器可读的当前任务与回执保存在 `project-control/`。

- [治理总则-GOV-0001-v1.0](治理总则-GOV-0001-v1.0.md)
- [假设和未决事项-GOV-0002-v1.0](假设和未决事项-GOV-0002-v1.0.md)
- [验证与豁免-GOV-0003-v1.0](验证与豁免-GOV-0003-v1.0.md)

治理规则的削弱、关闭或绕过属于高影响变更，必须由用户重新审核。

`project-control/tasks/**`、`project-control/reviews/**` 和 `project-control/current-task.json` 均为受保护机器记录，不得直接编辑；使用对应 CLI 读取或变更。用户在当前 Codex 对话中明确决定后，Codex 只能通过窄口径 `reviewctl record-conversation` 自动绑定治理状态并追加回执；旧 `record` / `waive` 保持禁用。R003 是最后一份 OpenSSH 迁移回执，历史私钥不得进入仓库、Codex 或日志。
