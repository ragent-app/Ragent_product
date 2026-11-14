# Factory 能力矩阵与证据边界

本表区分源码、启用条件和实际证据，不把代码路径或配置当作平台验收。共享后台 broker 是既定设计；任务绑定和权限不自动证明操作系统隔离。记录以本仓库源码为准，尚无真实结果的项目保持未验证。

| 范围 | 已有源码与配置条件 | 实际证据与限制 |
| --- | --- | --- |
| Windows / Codex app-server 共享 broker | `AGENTOC_CODEX_PROVIDER_READONLY=1` 且满足对应平台、runtime、thread 策略、MCP/app 清单和 provider readiness 检查后，才允许此只读路径；不符合条件拒绝。见 [runtime-adapter](../../chat/runtime-adapter.mjs) 与 [runner-sidecar](../../chat/runner-sidecar.mjs)。 | 这是 provider 报告和协商路径，尚无本次真实协商或只读强制效果证据；不能外推其他 runtime。 |
| Linux / 只读路径 | 现有 runtime 能力检查、bubblewrap 路径及 `2908eac6` 的显式 opt-in 共享 Codex provider 只读协商见 [runtime-adapter](../../chat/runtime-adapter.mjs)；runner-lifecycle 进程须接收对应配置并经 allowlist 传给 sidecar。 | `a6ee4851` 加 `bbd95785` 的真实规划 Run 以显式 on-request-read-only 完成，provider 报告 readOnly、network false、on-request、user reviewer 和正确 cwd；untrusted-read-only 另一次因 approval 不匹配在 prompt 前失败。Factory 备份审查 Run 已启动但 failed 并 finalized，实际 lifecycle 进程缺只读开关，usage 未证实；后续 Android 审查 Run 已 completed，provider thread 报告 readOnly、network false、正确 cwd、MCP 0 及可调用 app 0；`5a1ef95c` token guard 已以受限 overlay 部署，尚无新 Run 验证；这仅证明本次 provider 报告，正式报告验收因旧空 packet 未通过，跨 Harness 同图仍未验。 |
| macOS | 共用服务端模型和能力检查；未发现可据此宣称本机只读能力的实际证据。 | 本机执行、取消、重启和恢复均未验证；不从其他平台推断支持。 |
| Claude / 其他 Harness | 依实际 runtime 能力及现有准入决定；不能因品牌或模型名称推断只读、取消或用量证据。 | 真实 Factory 执行、任务级取消及与 Codex 同图交换证据未验证；缺失用量维持预算预留。 |
| Web / Android 客户端 | 已有组织、任务与消息入口，见 [Web](../../static/chat/organization-view.js) 和 [Android](../../android/feature/organization/src/main/kotlin/com/andysagent/agentoc/feature/organization/ui/ConnectedOrganizationScreen.kt)。 | 既有离线 Kotlin 编译不覆盖后续全部改动，也不证明真机、持久离线缓存或断线重连一致性。 |
| 数据与恢复 | [backup](../../scripts/factory-backup.mjs) 提供数据库备份，以及可选有界 Run 文件、已登记产物摘要观察；[shadow](../../chat/factory-shadow.mjs) 提供分页观察和本地运行状态聚合。 | 此前 inventory 曾观察 workflow 缺失；后续 `1927a085` inventory 观察三库均存在、1 个活动/未知 binding 与 2 个 scheduler lease，两个关联 Run 的 publication 匹配；remote 表未初始化、关联未知。未备份或恢复，产物与外部效果未观察；跨数据库/文件系统不声称原子。 |

环境前置：用户已授权本机及指定 `pinggu` 开发实例用于验收；使用实际实例和已有项目，遵循对应目录和权限边界。此前一次隔离登录命令被自动工具审查拒绝、未执行，不等于业务登录失败；本次不把它当作已通过的验收。现场配置、账号授权、实际运行身份和结果仍须逐项记录，不能把“已授权实例”写成“已验证”。

阶段 5 原完成标准仍包括真实重启连续性、多 Harness 同一工作图、多客户端、经授权发布和回退；详见 [阶段方案](phase-5-rollout.zh.md) 与 [待完成清单](remaining-work.zh.md)。
