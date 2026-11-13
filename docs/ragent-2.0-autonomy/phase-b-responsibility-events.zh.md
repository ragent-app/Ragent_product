# 阶段 B 持续责任与持久事件

[上一阶段 A](phase-a-execution-closure.zh.md) · [返回总览](README.md) · [下一阶段 C](phase-c-github-ci-autonomy.zh.md)

目标：建立与 Session 解耦的长期责任及可恢复事件入口。前置条件是 A 已明确执行、恢复和验收契约；责任只能引用现有 Goal、Work Item 和执行绑定。

## 工作包和顺序

| 工作包 | 实施内容 | 交付 |
| --- | --- | --- |
| B1 责任领域 | 责任身份、生命周期、修订、政策版本与组织/项目归属 | 加法 schema 与领域命令 |
| B2 持久事件 | Subscription、inbox、原始证据引用、去重和水位 | 可信事件接入契约 |
| B3 唤醒桥接 | Wake、租约代次、冷却和合并；扩展既有 Trigger action | Trigger 到责任的幂等桥 |
| B4 控制接口 | 创建、查询、修改、暂停、恢复、手动 wake 与历史 | 认证、版本及幂等 API |
| B5 活动投影 | 观察、决定、阻塞和执行关联 | 现有 Web/Android 任务入口上的责任与 Activity 基础视图 |

## Responsibility 和事件层的最小设计

推荐保留新的责任实体，但缩减原建议数据模型：

| 新增事实 | 最小字段与约束 |
| --- | --- |
| Responsibility | id、ownerPrincipalId、projectId、organizationId、objective、successCriteria、lifecycle、revision、rowVersion、policyRevision、nextCheckAt |
| Policy revision | 允许模板、资源范围、允许工具动作、审批条件、有效期、失败/并发限制、预算范围；版本不可变 |
| Subscription | responsibilityId、source、resource、eventTypes、过滤与冷却、启用状态、水位 |
| Inbound event | source/account/resource/eventId 唯一键、occurredAt、receivedAt、payloadDigest、payloadRef、来源验证状态 |
| Wake | responsibilityId、责任/政策版本、关联事件集合、dueAt、state、leaseGeneration、decisionId；合并必须保留原事件关联 |
| Decision receipt | 输入事实摘要、候选提案、确定性验证结论、使用量、结果命令及版本；模型输出仅是提案 |
| Responsibility work link | responsibilityId、wakeId、goalId/workflowInstanceId；引用已有 binding/Execution，不另存执行终态 |

生命周期采用 draft / active / paused / completed / cancelled / archived。等待审批、设备离线、预算不足放在带原因和解除条件的 attention/blocker 中，避免长期责任因某一轮 CI 失败整体变成不可恢复终态。“持续维护”默认不会因一次修复完成而 completed；completed 必须来自有限责任完成或明确用户结束。

责任暂停先禁止新决策/派发，再按用户选择对现有工作请求停止；“暂停已请求”与“执行已停止”分别显示。政策撤销在决定、合同准入、实际派发和工具副作用前检查，已产生的外部效果保留记录。

事件接入优先将 `triggers.mjs` 的 action 扩展为受控责任唤醒，保留旧 session_message。新责任事件以 SQLite inbox 为权威；若旧 Trigger 配置继续放 JSON，使用稳定 occurrenceId 和幂等桥接，不能跨 JSON/SQLite 宣称原子提交。首版保持单权威实例，避免让多个进程同时改旧 JSON 文件。

现有 Trigger 的真正类型为 at_time / event；interval 是 recurrence。事件白名单主要是 Run/Collaboration/Process/Session，且只保留有限事件键。外部事件必须新增来源验证、去重保留期和持久原始证据；“复用 Trigger”不代表直接把任意 Webhook 文本交给聊天即可。

API 可以保留原方案的 `/api/responsibilities` 用户入口，但内部通过现有 Factory Control 提交工作。所有写入使用明确 actor、expectedVersion 和稳定幂等键；同键异内容拒绝。wake 接口只返回持久受理回执，不承诺已启动或已完成。
## API 范围

| 方法 | 路径 | 业务含义 |
| --- | --- | --- |
| POST / GET | /api/responsibilities | 创建或列出责任 |
| GET / PATCH | /api/responsibilities/:id | 查询或按版本修改 |
| POST | /api/responsibilities/:id/pause | 阻止新准入，并明确是否请求停止现有工作 |
| POST | /api/responsibilities/:id/resume | 重新检查政策与状态后恢复责任准入 |
| POST | /api/responsibilities/:id/wake | 持久接收唤醒请求 |
| GET | /api/responsibilities/:id/activity | 查询可追溯的责任活动 |

上述是待实现协议。恢复责任不表示旧 Run 已恢复，也不自动重试未知副作用。删除或归档不级联删除 Session、Run、候选和工作成果。

## 模块与退出条件

候选模块为 responsibility-store、responsibility-service、responsibility-events 和责任路由；创建前再次检查等价实现。沿用 chat-server 生命周期，Work Item 派发继续归 Factory Scheduler。

本阶段交付 schema/迁移说明、领域与 API 契约、Trigger 桥接、活动投影、恢复和回滚记录。退出条件是责任及待处理事件在重启后可恢复、同逻辑事件不会重复生成业务工作、并发修改不会覆盖已提交版本、暂停和撤权阻止后续未授权动作。

依照[共用架构](architecture-and-boundaries.zh.md)及[验证发布规则](verification-and-rollout.zh.md)评估，既有 Session Goal 和 session_message Trigger 保持兼容。语义决策和 CI 自动工作流准入在 C 实施。

## 当前实现记录（待验收）

责任、不可变政策版本、事件、唤醒、活动和工作关联保存在 Collaboration SQLite；责任写操作使用版本与幂等键。时间订阅由责任侧扫描，最短间隔一分钟，遇到已有待观察唤醒时记录合并；它不派发 Work Item。旧 Trigger 投递路径未改，JSON 与 SQLite 不声称原子提交。人工唤醒和无 CI 事实的定时唤醒只进入等待，不能单独生成工作。暂停阻止新的责任准入；既有工作停止需要单独的明确控制，API 不把暂停显示为已停止。

责任 API 目前限定同实例认证的 owner；跨设备及受限代理身份尚需可信账户映射。每日预算采用 policy.dailyBudget 的 timeZone、maxRuns、maxTokens、maxCost，首次预留固定时区；改变时区需要迁移协议，未承诺运行费用硬上限。以上为源码记录，重启恢复、真实业务、平台兼容和发布均未验收。

责任后台默认关闭；只有设置 `AGENTOC_RESPONSIBILITY_RUNTIME_ENABLED=1` 才扫描和处理唤醒，单独的 Factory 控制、调度和组织授权仍须满足。等待状态按原因变更记录活动并冷却，周期合并保留累计数及首末到期时间；同一仓库事实摘要复用已有记录。新政策版本和新 CI 事件有独立身份，不沿用旧 wake 的冷却。记忆修改预览可读，提交默认关闭，须设置 `AGENTOC_RESPONSIBILITY_MEMORY_WRITES_ENABLED=1`，且必须确认有效预览摘要；实际业务与恢复仍未验收。
