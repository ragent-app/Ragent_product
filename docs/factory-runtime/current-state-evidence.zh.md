# Factory Runtime：现状与证据索引


2026-11-14 更新证据和现有检查请见 [实施状态](implementation-status.zh.md)；本页保留原核查基线。
日期：2026-11-13。配套：[总方案](00-master-plan.zh.md)。本文只记录静态核查，不代表功能验收通过。

## 1. 基线与证据等级

- 工作区：`G:/AgentoC/Ragent_product`；分支 `main`；核查 HEAD `3628b2ef5f5627fe2118bda40691150c8d1da74f`。
- 已检查根目录 AGENTS.md；在仓库中检索未发现更深层 AGENTS.md。本次不运行构建或应用，也不修改业务源码。
- 工作树存在并行改动，包括 `chat-server.mjs`、`chat/provider-contract.mjs`、`chat/run-launcher.mjs`、`chat/run-execution-boundary.mjs`、`lib/config.mjs`、Android 网络/工作台等；其他未提交文件也保留原样。
- S：直接阅读实现，可支持实现形态判断。I：从相邻调用链得出的风险或缺口，需要实施前进一步确认。V：真实运行验证，本次无此类证据。
- 文中的已有检查是候选验证入口，本次没有运行；不能把文件名中的 acceptance / end-to-end 当成真实业务端到端证据。
- `chat/`、`lib/`、`docs/` 及 Android organization 模块检索未见 `work_items` / `WorkItem` / `factory-scheduler` / `work-graph` / `GoalGraph` 对应的目标实现。结论限于本次检索范围，不声称所有历史工作树均不存在相关设计。

## 2. 已存在能力与真实限制

### E01 — 持久 Collaboration（S）

代码：[collaboration-store.mjs](../../chat/collaboration-store.mjs)、[collaboration-orchestrator.mjs](../../chat/collaboration-orchestrator.mjs)。

`collaborations / collaboration_plans / collaboration_tasks / collaboration_attempts / collaboration_dispatch_commands` 均已存在。`enqueueAttemptDispatch`、`claimPendingDispatchCommands`、`completeAttemptDispatch`、`reconcile` 和 `reconcileLedger` 实现派发与对账。

`completeAttempt` 把执行结果映射到旧 task.state；`markReadyTasks` 根据前置 task 的 succeeded 推进。不能直接把这个终态用作 Factory 的业务验收完成状态。

### E02 — 单任务与权限传播（S；真实运行未知）

代码：[collaboration-plan.mjs](../../chat/collaboration-plan.mjs) `compileCollaborationPlan`、[collaboration-leader-ingress.mjs](../../chat/collaboration-leader-ingress.mjs)、[collaboration-capability.mjs](../../chat/collaboration-capability.mjs)。

任务数为零被拒绝，一个任务在当前编译与入口范围内合法。[现有 plan 检查](../../tests/test-collaboration-plan.mjs) 包含一个任务的断言。不能继续照搬“必须先修至少两个任务”的旧描述。

[能力传播检查](../../tests/test-collaboration-capability-propagation.mjs) 检查 root / child manifest 的权限范围，使用 `missing-tool`。说明已有传播协议与检查，不证明真实 Harness 的所有输入路径已验证。

### E03 — Organization、持久岗位与管理树（S）

代码：[organization-store.mjs](../../chat/organization-store.mjs)、[organization-runtime.mjs](../../chat/organization-runtime.mjs)、[organization-planner.mjs](../../chat/organization-planner.mjs)。

已有 organizations、revisions、nodes、role_instances、delegation_grants、edges、grants、gates；node 有 stable_key、current_session_id、binding_generation。`createOrganization` 仍要求 rootSessionId，且为唯一绑定。

Planner 明确拒绝 MANAGES 多父和循环；不能把任意关系图能力视为已支持。现有结构适合扩展成管理树加审查/咨询关系。

### E04 — 实体化和阶段派发（S / I）

代码：[organization-provisioning.mjs](../../chat/organization-provisioning.mjs)、[organization-phase-dispatch.mjs](../../chat/organization-phase-dispatch.mjs)。

冻结修订可实体化 Managed Sessions。`dispatchOrganizationPhase` 校验绑定和 runtime，一节点生成一个单任务 Collaboration，当前生成的 policy/task 使用 shared / write；Reviewer 在下游可能被强制只读。

Factory 必须显式传递最终工作区及运行契约。当前 orchestrator 创建 staging 后使用 `managedTarget || createSession(...)`，需要沿真实 managed-target 接线确认其 folder/sourceContext 是否与 staging 一致；静态上不能假定新建 Session 的设置会自动应用到预先存在的 Session。

### E05 — 结构化操作和重规划（S）

代码：[organization-command-dispatcher.mjs](../../chat/organization-command-dispatcher.mjs)、[organization-operations.mjs](../../chat/organization-operations.mjs)、[organization-replan.mjs](../../chat/organization-replan.mjs)。

已有命令白名单、操作日志、Revision CAS、追加/退役节点和 `replaceManagedSession`。后者通过 bindingGeneration 替换绑定并记录事件；这不等于旧运行已停止。Factory 还需将旧执行存活、权限失效及候选结果采纳规则联结起来。

### E06 — 返工上下文仍有内存权威（S）

代码：[collaboration-orchestrator.mjs](../../chat/collaboration-orchestrator.mjs) `reworkContext`、`dispatchRework`、`completeRun`。

返工创建时把 organizationId、phaseId、parentPacketId、nodeId、revision 放入 Map；完成时读 Map 生成 Packet lineage。当前读取范围内未见该 Map 从持久化记录重建。应将该 lineage 与创建/派发意图一起落盘。这里是静态恢复风险，未进行重启复现。

### E07 — 消息和角色上下文已有基础（S）

代码：[organization-messaging.mjs](../../chat/organization-messaging.mjs)、[organization-context-projection.mjs](../../chat/organization-context-projection.mjs)、[context-projector.mjs](../../chat/context-projector.mjs)。

Typed Envelope 有 TASK_ASSIGNED、REVIEW_REQUESTED、BLOCKER_REPORTED、PLAN_AMENDMENT_AVAILABLE 等类型及 pending/claimed/delivered/acknowledged/dead_letter 状态；过期回收增加 delivery_generation。payloadRef 限引用且禁止 body/message/prompt 等正文。

上下文按角色投影，默认有大小上限。新增任务知识应扩展它，不再建立全量聊天广播。

### E08 — Governor 预算（S）

代码：[organization-governor.mjs](../../chat/organization-governor.mjs)。

已有 reserve / settle / release、过期预留释放、进展白名单及停滞动作。维度含 agents、runs、retries、replans、sessionReplacements、tokens、cost、elapsedMs；组织计数按 organization + revision 保存。Factory 跨修订总额度和瞬时并发需要独立清楚的口径，不可把修订升级当额度重置。

### E09 — 多持久化域（S）

代码：[orchestration-store.mjs](../../chat/orchestration-store.mjs)、[result-packets.mjs](../../chat/result-packets.mjs)、[workspace-leases.mjs](../../chat/workspace-leases.mjs)。

Collaboration / Organization / Orchestration 共用 collaborations.sqlite；ResultPacket / ProjectHandoff 使用 project-workflow.db；WorkspaceLease 使用 runtime-coordination.db。不能把这些调用包装成“同一次 SQLite 原子事务”的承诺。

Orchestration 已有 Execution/Step/Command/Interrupt/Validation。Collaboration 镜像代码明确保留原领域事实为权威，不能由 Factory 改成双写争夺完成状态。

### E10 — WorkspaceLease 已改为 mutation 生命周期（S / I）

代码：[run-admission.mjs](../../chat/run-admission.mjs) `initWorkspaceLeaseRecovery`、[workspace-leases.mjs](../../chat/workspace-leases.mjs) `recoverMutationLeases`、[mutation-coordinator.mjs](../../chat/mutation-coordinator.mjs) `executeMutation`。

当前启动入口调用 mutation 级回收；旧 `recoverLeases` 的活性判断不代表当前 Run admission 持续持锁。`executeMutation` 取得短租约、检查 expectedVersions、执行 mutate、finally 释放；没有看到对任意 mutate 回调的超时终止或持续 fence 检查。精确资源键冲突不自动覆盖文件键与 workspace 键之间的包含关系。

这支持“Factory 需要补全长执行与实际写入隔离”的判断，不支持声称已复现数据竞争。

### E11 — Managed Writer 回写时机（S）

代码：[managed-writer.mjs](../../chat/managed-writer.mjs) `createStagingWorkspace` / `commitStagingToCanonical`、[collaboration-orchestrator.mjs](../../chat/collaboration-orchestrator.mjs) `completeRun`。

完成回调在创建 ResultPacket 前处理 staging diff 并回写 canonical。commitStagingToCanonical 做路径验证及文件应用，最终清理 staging；其 executeMutation 调用未传 expectedVersions。不能视作已具备审查前候选保留、基准版本校验或 Git 合并流水线。

### E12 — 只读平台边界（S）

代码：[runtime-adapter.mjs](../../chat/runtime-adapter.mjs)、[runner-sandbox.mjs](../../lib/runner-sandbox.mjs)、[reviewer 检查](../../tests/test-reviewer-readonly.mjs)。

内置 reviewer 认证要求开关启用、platform=linux、匹配 reviewer runtime，并经 bubblewrap 构造检查。其他未注册 runtime 的默认能力为不认证。默认本地 Windows/macOS 路径不能以 Prompt、Reviewer 名称或空 writablePaths 证明只读。

### E13 — ResultPacket 与 Gate（S）

代码：[result-packets.mjs](../../chat/result-packets.mjs) `normalizeEvidenceList` / `createExecutionResultPacket`、[phase-gates.mjs](../../chat/phase-gates.mjs) `acceptanceSatisfied` / `completePhase`。

Packet 有不可变 digest、Run 来源和证据缺失时的状态归一化；phase 完成要求 passed Gate 及非空验收证据。`acceptanceSatisfied` 接受非空引用，未在该函数解析实际证据内容、验证完整 criterion 集或绑定候选 commit。Factory 验收应在这些基础上补完可信来源和内容版本，不重新发明包存储。

### E14 — 开关与真实能力不同层（S）

代码：[config.mjs](../../lib/config.mjs)、[organization-runtime-capabilities.mjs](../../chat/organization-runtime-capabilities.mjs)、[Deb 环境配置](../../packaging/deb/agentoc.env)。

原始开关多数默认 false；`organizationFeatureEnabled` 对部分未显式配置的能力采用兼容启用逻辑；Deb 环境显式打开一组开关。Proposal / provisioning 等又依赖原始开关组合。实际有效能力需要具体实例读取及调用链核查，本次未读生产配置，也未修改开关。

### E15 — 已有 Web / Android 与接口差异（S / I）

代码：[Web organization-view.js](../../static/chat/organization-view.js)、[组织 API](../../chat/router-organization-routes.mjs)、[Android OrganizationApi.kt](../../android/feature/organization/src/main/kotlin/com/andysagent/agentoc/feature/organization/data/OrganizationApi.kt)、[Android DTO](../../android/feature/organization/src/main/kotlin/com/andysagent/agentoc/feature/organization/data/OrganizationDtos.kt)。

Web 解包 `payload.projection`。服务端 GET 返回 `{ projection }`；所读 Android RealOrganizationApi 直接把 response.body 解码成 OrganizationProjectionDto，DTO 要求顶层 organizationId。所读 OkHttp 传输保存 JSON 原文，未在该处看到解包。属于明确的静态契约不一致，实际使用路径与真机现象仍待确认。

Android 模块已有图布局、节点详情、状态归约及现有检查；不等于已有 Factory 任务板或自由指挥。当前公开组织 API 有 owner 边界、projection/cancel/provision/phase dispatch，并非通用 Work Item 控制 API。服务端投影版本取决于开关，不能只依赖客户端 version 查询参数判断协商成功。

### E16 — Managed Input 和 Steering（S）

代码：[managed-input.mjs](../../chat/managed-input.mjs)、[provider-contract.mjs](../../chat/provider-contract.mjs)、[harness-contract.mjs](../../chat/harness-contract.mjs)。

已有 Managed Session 输入限制，不能为直接指挥删除该边界。所读 runtime family 契约中，codex-json 不声明 steer；codex-app-server-json 声明 steer/interrupt；Claude 双向路径说明为 interrupt + next-turn。provider-contract 工作树有未提交修改，须以具体安装版本和运行确认再次核验。

### E17 — 真实执行验证与测试边界（S，V 缺失）

[组织 acceptance 检查](../../tests/test-autonomous-organization-acceptance.mjs) 自身说明使用 SQLite 场景和 fresh-process read 模拟进程崩溃，真实服务重启是独立项。它不能证明真实系统服务与 Harness 恢复。

本次只阅读既有检查入口，没有运行它们；未调用 Harness、启动服务、访问真实业务数据库或修改用户工作区成果。Windows、Linux、macOS 与 Android 的实际支持矩阵仍需阶段 5 取得明确证据。

### E18 — 已有知识交接基础（S）

代码：[project-handoffs.mjs](../../chat/project-handoffs.mjs)、[result-packets.mjs](../../chat/result-packets.mjs)、[organization-context-projection.mjs](../../chat/organization-context-projection.mjs)。

已有 project_checkpoint 与不可变 ProjectHandoff 引用，按需投影决策、风险、验收和成果。新的长期岗位知识应增加任务级关系和来源/失效规则，不复制整个历史，也不将模型摘要提升为权威事实。

## 3. 核心文件指纹

SHA-256 来自本次静态读取，便于后续区分并行修改。这里只列关键证据文件，不构造整仓副本。

| 文件（仓库相对路径） | SHA-256 |
| --- | --- |
| chat/collaboration-orchestrator.mjs | DDA2D519207C4B55C482E1458FA077505491281986E72F9DDA24ED345B1C379F |
| chat/organization-phase-dispatch.mjs | 39897E7F137D781458DD551816875326DFFD9D492665A496A2918330847D6E08 |
| chat/workspace-leases.mjs | 01E94EEE7058B3DC8BA4EC37081D01BB1637902FC02CAB10012FDE03C7CC5D7E |
| chat/mutation-coordinator.mjs | A00A7DB971A039A30C1C6BEBACBF5577C3C2EB18DB85A129BC7978C5C792CFFE |
| chat/phase-gates.mjs | 964C3EC785338E9F329C2B929F6CA6E018D1DA0B1E55AD6F7FFF7F6D5392823A |
| chat/organization-runtime-capabilities.mjs | 7AAD109615070E22ECD251FD185B8FADB08FDB3CB8B05503C913A3432A95079A |
| chat/provider-contract.mjs（有并行修改） | 7C99243CB91F88731A712DAB6DE72C5653084E812BAA63599A7A30016E8E8A89 |
| lib/config.mjs（有并行修改） | BFE34F18BCCC17439E23E99B71D9C8A5410ACDB56B0CBA518A2F4EC0F3C65AE1 |

## 4. 后续更新规则

每次开始阶段实施，先记录实际 HEAD 和相关未提交差异。已有缺口若已被其他工作修复，更新证据和待办，不重复修改。新增运行证据至少标明源码身份、实际平台、有效配置、真实 Harness、业务输入来源、执行时间、结论和残余限制；删除日志前保留紧凑索引和产物身份。
