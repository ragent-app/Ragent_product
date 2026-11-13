# 阶段 0：现状收敛与执行底座前置修复

状态：待实施。日期：2026-11-13。依据：[总方案](00-master-plan.zh.md)、[现状证据 E01–E18](current-state-evidence.zh.md)。后续：[阶段 1](phase-1-work-graph.zh.md)、[阶段 2](phase-2-execution.zh.md)。

## 1. 阶段目标

形成可以安全承接 Work Graph 的已知执行边界。保留现有 Collaboration / Organization，修复静态确认的关键缺口，核实有风险的真实接线，避免在错误的基础假设上新增调度器。

本阶段不重做组织 UI，不引入外部框架，不批量重构 Session Manager，也不把所有当前产品问题都纳入 Factory 项目。

## 2. 输入与进入条件

- 以实际开始实施时的 HEAD、相关文件差异与有效安装版本重读证据索引；当前基线工作树存在并行改动。
- 找到与目标代码匹配的既有检查及已存在真实项目资料；缺业务 oracle 时明确留空。
- Windows TEMP/TMP/TMPDIR、缓存、隔离实例和输出固定在 G:/AgentoC；重新检查容量。不得为本阶段直接清理其他工作的 worktree。
- 不运行生产服务重启、迁移数据库或真实发布；需要实际环境证据时先明确作用域并遵循该环境已获授权。

## 3. 工作包

### P0-01：现状和能力清单

交付一张“源码能力 / 有效开关 / 实际运行能力 / 已有证据”的矩阵，分别列出配置读取、运行准入和客户端展示。

- 核对 organization-runtime-capabilities 的兼容启用逻辑与直接读取原始开关的入口。
- 核对组织阶段派发、自动 provisioning、恢复、输入限制、只读审查和可写执行的依赖组合。
- 为 Factory 新准入定义显式能力判定，禁止因为某个默认兼容值为 true 就绕过实际执行检查。
- 审阅阶段 dispatch 路由与下游检查，确认关闭能力时不会由备用入口启动新任务。保留既有事实的读取、恢复和取消能力。
- 记录部署平台真实可用 runtime family，区分配置选项与可运行能力。

涉及：`lib/config.mjs`、`organization-runtime-capabilities.mjs`、`router-organization-routes.mjs`、`organization-phase-dispatch.mjs`、打包环境配置。配置名称中的历史兼容前缀不在本阶段顺带更名。

### P0-02：返工 lineage 持久化

将 rework 的 organizationId / phaseId / parentPacketId / nodeId / revision 与 Collaboration 创建意图关联持久保存；完成回调读取持久事实，而非依赖 `reworkContext` Map。

约束：

1. 记录应在可能启动 Run 之前存在；同键重复请求返回同一返工关联。
2. Gate 变更与创建意图中断后可对账，不因重试再推进一次 Gate generation。
3. 不能为历史缺失的 parentPacketId 猜测补值。缺失者标记待确认，保留旧 Attempt 和 Packet。
4. 结果链仍追加新 Packet，不覆盖旧 Packet 或旧 Gate。

涉及：`collaboration-store.mjs`、`collaboration-orchestrator.mjs`、`phase-gates.mjs`、`result-packets.mjs`、既有 reconciler。

### P0-03：Managed Session、工作区和授权接线

从组织阶段派发逐步追到实际 Run manifest，确认 effective accessMode、executionIsolation、projectId、工作目录、路径范围、Grant 与当前绑定代次一致。

重点检查：预先存在的 managedTarget 与新 staging 组合时，实际 Session 是否获得正确的隔离执行范围；是否仍把 canonical 作为运行目录；新建 Session 的 sourceContext 是否被错误假定已附加到旧 Session。

发现不一致后修复真实数据传递。对于不能安全重绑定的 Managed Session，采用独立执行绑定/Session，不在运行中覆盖旧 Session 的目录。不得通过扩大 canWrite 或关闭 Managed Input 规避问题。

单任务目前已支持，能力传播已有代码和检查，不再预置“必修 bug”。只在当前链路出现可定位偏差时改动。

### P0-04：候选写入模式及 mutation 边界

为阶段 2 形成可编码的改造接口：Factory-owned Attempt 在完成时提交候选，不自动回写 canonical。旧任务继续旧语义，归属字段由服务端产生，用户或 Agent 不能通过随意传一个 flag 获得旁路权限。

明确以下不变量与负责模块：

- 调度 claim 和 mutation lease 分离；Run 活着不代表持有短锁，短锁过期不代表 Run 已停止。
- Factory 集成使用统一规范化目标资源键；文件键、git-index 键与 workspace 键之间的冲突策略显式定义。
- 对耗时 mutation 必须选择受控短操作、可续租并持续验证的操作或不可接管的隔离机制；仅保存 hardTtl 不会自动终止回调。
- 集成前校验真实 base/head/文件版本，保留恢复日志；现有 commitStagingToCanonical 未传 expectedVersions 的调用不能作为完成设计。
- 终止或隔离证据不足时阻塞冲突工作；不自动清除未知旧运行占用。

本阶段可先冻结接口并禁止不安全入口；具体候选/集成实现属于阶段 2。任何相关风险未解决前，该环境不能进入无人值守 Factory Writer 准入。

### P0-05：只读认证和平台能力

确认 Linux bubblewrap 的实际可执行性和运行隔离链；将认证只读、普通本地执行、隔离 Writer、可取消与可 steering 分开报告。

Windows/macOS 没有认证只读实现时，保持拒绝并说明缺失能力；经授权的远端 Linux 可作为执行目标，但要有现成连接与实际接线。不能以 `readOnlyRequired=false` 或普通 Reviewer Prompt 冒充解决。

### P0-06：已有组织读接口一致性

核对组织 GET 响应 `{ projection }` 与 Android DTO 解码；统一包络和 schema version 协商，并核实 organization 模块是否在实际工作台入口使用。修正准确的接口消费位置，保留旧客户端兼容。

本阶段只收敛已有读链，不提前建 Factory 编辑器。若实际生产使用另一条消费路径，应记录范围，不把静态差异夸大为所有 Android 页面故障。

## 4. 既有证据与检查选择

| 改动范围 | 已存在检查入口 | 证据限制 |
| --- | --- | --- |
| 计划和派发 | `tests/test-collaboration-plan.mjs`、`test-collaboration-task-contract.mjs`、`test-collaboration-orchestrator.mjs` | 只验证其已有断言，不等于业务交付 |
| 权限传播 | `tests/test-collaboration-capability-propagation.mjs`、`test-collaboration-capability.mjs` | missing-tool 等路径不证明真实 Harness |
| 组织实体化和修订 | `tests/test-organization-provisioning.mjs`、`test-organization-provisioning-route.mjs`、`test-autonomous-organization-s22.mjs` | 检查实际 fixture 与适用平台后再选择 |
| 结果/写入/租约 | `tests/test-managed-writer.mjs`、`test-mutation-coordinator.mjs`、`test-workspace-leases.mjs`、`test-result-packets-v2.mjs` | 不能把构造数据作为真实竞争或跨进程恢复证据 |
| 能力/投影 | `tests/test-organization-runtime-capabilities.mjs`、`test-reviewer-readonly.mjs`、`test-organization-projection-v2.mjs` | 平台拒绝和运行隔离不是同一层证据 |

只运行与已实施修改直接相关、具有可靠既定预期的检查。没有现成覆盖的恢复风险，先静态审阅和记录未验证项；新增自动化须另行获准。

## 5. 退出条件

- 返工 lineage 不再仅靠 Map，既有事实与新执行关系可追溯。
- 已确认阶段派发与实际工作区/Grant 一致；无法保证的路径明确禁用。
- Factory 候选先冻结的接口与归属边界明确，旧模式兼容。
- mutation TTL、目标版本和资源锁策略有明确实现决定，不把旧注释当成当前行为。
- 平台与开关矩阵区分源码存在、有效配置和真实验证。
- 已有 Android 读接口差异被修复或通过实际消费路径排除，并保留证据。
- 交付变更说明、相关源码身份、已有检查结论及残余限制，不报告不存在的真实重启/业务验收。

## 6. 回退与交接

本阶段采用加法数据修复；返工历史保留，禁止回退时删掉新 lineage。工作区/权限改动应通过明确开关只影响新路径。回退停止新 Factory 准入，继续旧模式读取与终态收集，不取消用户正常会话。

向阶段 1 交付：事实来源和兼容约束。向阶段 2 交付：候选模式、授权接线、平台能力和禁止自动接管的条件。未验证的项按风险影响阻断对应能力，不拖延无依赖的数据模型工作。
