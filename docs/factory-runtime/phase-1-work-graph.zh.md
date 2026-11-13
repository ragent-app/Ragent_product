# 阶段 1：持久 Work Graph 与权威控制协议

状态：待实施。日期：2026-11-13。上位：[总方案](00-master-plan.zh.md)。前置：[阶段 0](phase-0-baseline.zh.md) 的事实边界；后续：[阶段 2](phase-2-execution.zh.md)。

## 1. 目标与范围

在现有组织和 SQLite 上增加独立于 Session / Collaboration 生命周期的目标和任务。先支持持久创建、读取、修改、依赖管理及合法状态转换，默认不自动启动新 Run。

初版只覆盖单组织、单项目内任务图；目标使用列表和可选父目标关系。禁止一开始引入跨实例 DAG、通用脚本引擎或另一个执行调度事实库。

## 2. 设计交付物

必须在编码前固定到仓库设计中的内容：

1. 字段与索引、唯一约束和引用生命周期。
2. 状态转换表及各转换的授权主体、前置条件、事件和幂等规则。
3. Work Graph / Organization / Collaboration / Run / Orchestration 的写入职责。
4. API / 领域命令的请求与返回协议，包括冲突、未授权、能力缺失和异步完成。
5. 新旧路径的 ownership 标记和迁移/回退规则。

## 3. 工作包与实施顺序

### P1-01：加法 schema 和事务入口

建议在 collaborations.sqlite 增加 Goal、Work Item、不可变 Work Contract、Dependency、Execution Binding 和 Acceptance Decision 表。具体名称以总方案为起点；复用现有操作/事件设施，避免重复 outbox。

约束至少包括：

- Work Item ID 与旧 taskId 分开，不能以 rootSessionId 作为主键。
- Work Contract `(workItemId, contractRevision)` 唯一且不可变；当前版用显式指针。
- 同一 workItem 同时最多一个活动 executionEpoch；派发幂等键唯一。
- Dependency 端点必须存在、同项目、不能自依赖；新增边在同事务检查整个受影响图无环。
- 事件和 CAS 状态变化同连接提交；同一数据库文件上的不同连接调用不视为事务。
- 新 schema migration 使用独立迁移记录/命名空间，不能随意占用 Organization 已有 PRAGMA user_version 语义。
- 删除采用归档/墓碑，活动任务、未完成操作和被引用证据不可级联清除。

增加基础索引：组织/项目/goal、state+priority、assignee、依赖入边/出边、活动绑定、事件 cursor。读取分页有稳定顺序，不能只返回前 500 条后认定任务不存在。

### P1-02：命令入口与安全边界

建议领域命令：`CreateGoal`、`ReviseGoal`、`CreateWorkItem`、`ApproveContract`、`ChangePriority`、`AssignWork`、`AmendContract`、`ChangeDependencies`、`RequestPause`、`ResumeWork`、`RequestCancel`、`RetryWork`、`SubmitCandidate`、`DecideAcceptance`。名称为待实现协议，不是既有接口。

每条命令包含 commandId、target、expectedVersion、idempotencyKey、payload；actor、权限和执行来源由后端认证注入。涉及执行时增加 contractRevision / executionEpoch / bindingGeneration；涉及验收时增加 candidateDigest / gateGeneration。

规定幂等作用域为实例内“主体 + 命令类型 + 目标 + key”，同时保存 payload digest。同键同内容返回原 operation 及最新结果；同键异内容返回冲突。不能因客户端重连重复创建任务或重复取得审批。

Factory Control 复用现有 Organization Operations / Orchestration Interrupt，映射用户 principal 与 Agent node principal，不伪造 owner Session。所有入口均执行领域授权，不能只依赖前端隐藏按钮。

### P1-03：状态机

| 起点 | 命令/事实 | 终点 | 必要条件 |
| --- | --- | --- | --- |
| proposed | 授权契约 | ready / blocked | 契约有效；依赖满足则 ready，否则说明原因 |
| ready | 调度认领 | claimed | CAS、授权、槽位、派发意图一并确定 |
| claimed | 实际 Run 绑定 | running | 绑定属于当前契约和 epoch |
| running | 提交候选 | review | 已确认终态或允许的可信 checkpoint，候选内容固定 |
| review | 全部必需验收通过 | completed | criterion 全集匹配，证据可信，必要独立审查成立 |
| review | 授权返工 | ready / blocked | 新 epoch、返工关联持久化；旧候选继续可查 |
| claimed/running | 结果未知或外部阻塞 | blocked | 结构化 reason；保留可能存活的绑定 |
| running | 确定失败且无自动重试 | failed | 实际失败证据及重试策略 |
| failed/blocked | 重试/解除阻塞 | ready | 旧执行安全处置，预算与授权有效 |
| 任一非终态 | 取消请求 | 原业务状态 + cancel_requested | 先持久化请求，不伪造终止 |
| 非终态 + cancel_requested | 停止/隔离确认 | cancelled | 无可采纳的迟到执行副作用 |

暂停使用 controlState；未确认前保留 pause_requested，确认后为 paused。完成与取消终态不可原地重开；新的修复目标生成关联 Work Item。

依赖里程碑支持候选就绪与正式验收分离。审查任务可依赖固定 candidate_ready；普通执行默认依赖 accepted；发布依赖 integrated 及候选包 Gate，避免循环等待和抢跑。

### P1-04：版本与影响分析

优先级和可安全变更的排队属性只增加 rowVersion。修改目标、输入、路径、验收和技术方案产生新 contractRevision。换执行者或重试增加 executionEpoch；会话绑定变化另增 bindingGeneration。

改图事务生成受影响清单：活动绑定、旧候选、已有验收、后续工作与审批。运行中实质改约必须显式选择停止后改派或保留旧版但不再采纳；已完成任务通过新增后续任务处理。不能通过修改依赖默认放行旧工作。

组织修订和任务契约分开固定。Grant 撤销对新准入立即生效，对活动执行触发控制处置；旧执行快照不能成为继续越权的理由。

### P1-05：新旧映射与只读投影

引入服务端 ownership `legacy / shadow / active`，明确唯一状态推进者。shadow 只映射原任务事实，不调度、不自动构造“验收通过”。保留 sourceCollaborationId、sourceTaskId、attemptId / runId 等关系。

新增任务列表/详情读取与受控命令接口；返回 schemaVersion、rowVersion、contractRevision、asOf、分页 cursor、阻塞原因、活动命令和证据引用。不要扩展旧 /api/collaborations 为第二个 Work Item 写入口。

对旧 rootSessionId 仍保留引用，组织ID才是新增 API 的长期寻址对象。阶段 1 不强制迁移所有旧组织。

## 4. 涉及模块

- 新增建议：`chat/work-graph-store.mjs`、`chat/work-graph.mjs`、`chat/factory-control.mjs` 及对应路由薄层。
- 复用：`collaboration-store.mjs` 的数据库入口、`organization-store.mjs`、`organization-operations.mjs`、`orchestration-store.mjs`、认证/审批和 invalidation 机制。
- 保留：ResultPacket / WorkspaceLease 的独立存储，不在本阶段迁库。

领域模块不得持有 Harness 私钥或直接启动 Runner；事务中不得等待 LLM 或复制目录。

## 5. 证据与退出条件

先实现，再审阅迁移、直接依赖与事务边界。已有 `test-collaboration-store.mjs`、`test-organization-store.mjs`、`test-orchestration-store.mjs` 可按实际改动选择，证明旧域兼容；它们不能自动证明新 Work Graph 正确。

阶段退出应有以下事实可检查：

- 任务与契约可持久保存和分页读取，Session 生命周期不决定任务是否存在。
- 同一领域只有一个合法写入口；冲突和重复命令有确定处理。
- 任务图、版本、取消/暂停语义、旧执行失效与验收里程碑完整记录。
- shadow 不派发；active 默认未启用真实执行；旧任务不被新调度抢走。
- 加法迁移和旧版本读取约束已审阅，未验证项逐条列明。

本阶段没有可靠的新行为 oracle 时不补造微测试。新增测试或测试基础设施需另行许可；真实执行与恢复证据由阶段 2、5 在已授权环境取得。

## 6. 回退与下一阶段输入

关闭新准入和 active 路由写入后保留新增表与记录，不下迁移删除任务。旧 Collaboration 继续按原规则运行，shadow 只读可关闭。将最终 schema、命令规范、ownership 和状态机交给阶段 2，不让 Adapter 自行补全缺失语义。
