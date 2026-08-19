# 项目文档导航

文档按用途分开维护，禁止将所有内容堆在同一目录或用单份文档替代完整记录。

| 目录 | 维护内容 | 入口 |
| --- | --- | --- |
| `project/` | 项目用途、边界、规模、发布单元和数据边界 | [项目文档](project/README.md) |
| `requirements/` | 按需求拆分、版本化的产品和治理需求 | [需求文档](requirements/README.md) |
| `development/` | 分支、实现、评审、注释、依赖和兼容流程 | [开发文档](development/README.md) |
| `operations/` | 环境、发布、迁移、回退和运行维护 | [运维文档](operations/README.md) |
| `troubleshooting/` | 问题现象、诊断证据、处置和复盘 | [排障文档](troubleshooting/README.md) |
| `decisions/` | 有上下文、选项、结论和后果的决策记录 | [决策记录](decisions/README.md) |
| `governance/` | 门禁、审核、假设、验证和豁免规则 | [治理文档](governance/README.md) |

## 维护规则

- 每次开工前先更新对应需求和任务范围；变更后同步相关开发、运维、排障或决策文档。
- 文档中的状态、负责人、版本、日期、关联任务、验证与未决事项不得省略。
- 历史版本保留为独立 Git 历史和任务/决策记录；不要在代码注释中维护变更日志。
- 文档与机器状态冲突时运行 `reconcile` 并停工处理，不得静默修正或继续开发。
- 新审核回执采用用户明确对话决定和 `reviewctl record-conversation` 的范围绑定；它是审计记录而非密码学身份凭证。本地 PASS 由受控 runner 派生，私有 GitHub CI 证据由仓库外只读凭据在线核验。Hook 只覆盖其接管的调用，不能替代 CI、分支保护或系统安全边界。
- 多发布单元证据按 `mac`、`win`、`backend` 分别维护；Windows 治理 runner 通过不等于真实 Windows 客户端验收。

## 文档完整性门禁

待审核或已批准需求必须同时满足：

1. `project`、`requirements`、`development`、`operations`、`troubleshooting`、`decisions`、`governance` 七类目录及入口存在。
2. 需求目录为 `<需求名>-<REQ-ID>/`，主文档以需求名开头并包含 REQ-ID 和版本。
3. 24 个默认章节存在、顺序正确且每节非空；不适用项写明理由与确认依据，不保留“待填”占位。
4. UI 需求有用户流程图和交互状态说明；非 UI 需求有合适的状态图、时序图或数据流图，并用文字覆盖边界、失败和恢复。
5. 假设和未决事项清单存在，高影响事项标明确认人与最迟确认阶段。
6. 文档本地链接可解析，需求版本、任务范围和审核回执一致。

模板文件可保留“待填”作为填写提示；复制形成具体需求后，进入审核前必须清空全部占位。
