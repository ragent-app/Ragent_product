# Ragent 2.0 自治升级分阶段方案

本目录将原修订方案拆为六个实施阶段，另用两份共用说明保存架构约束和验证发布规则。MVP 为 A + B + C，后续 D、E、F 按依赖扩展。

持续责任是通用的目标、授权、触发与结果模型；GitHub CI 是首个具体适配示例，不是责任的唯一用途。实际能自动执行的场景取决于已接入的适配器、明确授权和可验证的执行边界，不能仅凭创建目标推断任意任务可用。

这些文件是实施计划，不表示阶段已经完成。源码判断继承原审计基线 `baf143c3ecfe823e1dadc52f6ea2045e3e1d5c91`；拆分日期为 2026-11-14，本次没有重新审计代码。开始实施前应核对当前提交及并行修改，不能把旧基线发现直接当作最新缺陷。

| 阶段 | 文档 | 核心交付 | 前置依赖 |
| --- | --- | --- | --- |
| A | [基线固定和执行收敛](phase-a-execution-closure.zh.md) | 补齐现有 Factory 执行、依赖、恢复和验收链 | 固定当前源码与并行工作边界 |
| B | [持续责任与持久事件](phase-b-responsibility-events.zh.md) | Responsibility、政策版本、inbox、wake、责任控制 | A 的执行契约和状态归属明确 |
| C | [GitHub CI 自治闭环](phase-c-github-ci-autonomy.zh.md) | 迁移已有 CI 入口，连接受限决策、Factory 和审批汇报 | A、B 满足阶段退出条件 |
| D | [长期上下文与组织调整](phase-d-context-organization.zh.md) | 来源记忆、交接、目标修订、Harness 替换、预算窗口 | A–C 的责任与执行关联稳定 |
| E | [跨设备和外部动作](phase-e-devices-connectors.zh.md) | 设备能力、远程回执、连接器动作策略 | A–C 的身份、授权和恢复契约稳定；需要跨执行者交接时依赖 D |
| F | [语音与产品体验](phase-f-voice-experience.zh.md) | 责任语音操作、上下文续接、审批引导 | A–C 的业务 API 稳定；跨设备体验依赖 E |

共用说明：

- [架构、状态权威和模块边界](architecture-and-boundaries.zh.md)：所有阶段的设计约束。
- [验证、灰度与回滚](verification-and-rollout.zh.md)：所有阶段的证据标准和发布规则。
- [原完整方案与审计记录](../ragent-2.0-autonomy-revised-plan-2026-11-13.zh.md)：保留完整审计上下文，后续阶段执行细节在本目录维护；若调整共同架构或范围，需要同步总览和受影响文档。
- [剩余工作与验收顺序](remaining-work.zh.md)：按注明的审计基线区分 MVP 放行、原 Phase 0–5 对照与后续扩展。

按 A → B → C 推进 MVP。D–F 是后续路线，表中的依赖是接口与验收依赖，不代表必须把所有工作机械串行，也不授权自动启用、发布或新增测试。

当前工作区状态：A 的执行收敛、B 的责任事件和 C 的 CI 入口已有源码接线；D 的上下文和目标/预算扩展、E 的远程执行与单文件授权、F 的责任体验与语音均为部分实现。各阶段均未完成相应真实环境验收或发布，具体范围和限制见[实施状态](implementation-status.zh.md)。

## 当前实现和原方案的关键差异

| 领域 | 可确认的源码事实 | 修订决定 |
| --- | --- | --- |
| 跨 Session 目标与任务 | `factory_goals`、`factory_work_items`、不可变合同、依赖、执行绑定、候选、验收和交付里程碑已经存在 | 复用 Work Graph；取消从零新建同等 GoalNode 和 ExecutionLink 的计划 |
| 后台执行 | Factory 已有轮询、租约、generation、CAS、原子容量认领及 Collaboration 适配 | Supervisor 只新增事件决策职责，不拥有第二套任务派发和重试权 |
| 持久责任 | Factory Goal 有 objective、验收基线、父目标、修订；尚不具备完整周期、订阅、长期授权和责任生命周期 | 新增薄层 Responsibility，链接现有 Goal 和工作流 |
| 动态组织 | Organization 已有节点、绑定代次、Grant、重新规划、消息、岗位配置和生命周期 | 先整合，之后再补自动选人和替换；不能把这些全部算新增 |
| 预算 | Governor 已有事务预留、结算、释放；Factory 预留跨组织修订累计且不自动过期 | 扩展责任范围与时间窗口；不重建成本账本 |
| 工程交付 | 有候选封存、独立审查意见、人工验收、注册检查、单候选集成和发布协议 | 先贯通证据链；组合验证正在开发，发布 provider 未等于实际可用 |
| Trigger | JSON 持久化、串行变更、定时和事件投递、重试及回复发布结果对账 | 复用入口和调度语义，但补持久事件 inbox；不能视为已有事务事件总线 |
| GitHub CI | `scripts/github-ci-auto-repair.mjs` 已轮询失败并创建 Session/Run | 改造成 Observer → Responsibility → Factory 的入口，保留现有采集和筛选逻辑 |
| Session Goal | 会话内续跑，最多 10 次、最小 5 秒间隔、连续 2 次无进展停止 | 保持兼容，不能作为跨 Session 责任权威 |
| Memory | Project Memory 的 SQLite 提交为权威，Markdown 为投影；有来源范围、任务租约和恢复 | 先组合事实与任务证据，后扩展用户记忆；不先建通用向量库 |
| 权限 | permission-policy/v3 已有 STANDARD / FULL_AUTONOMY、ONE_OPERATION / RUN / SESSION 能力范围、签名及 nonce 相关边界 | 产品自治等级映射到现有权限事实，避免另立互不兼容的模式枚举 |
| 客户端 | Web Tasks 入口和 Android FactoryWorkScreen 已接现有 Factory API | 增加责任和活动投影，复用任务控制页面 |
| 语音 | Android 和 voice connector 等仍有基础；旧 local-voice API 有明确 410 退役契约 | 不把旧本地语音服务列为直接恢复对象 |

主要依据：`chat/work-graph-store.mjs:4`、`chat/work-graph.mjs:53`、`chat/factory-runtime.mjs:13`、`chat/factory-scheduler.mjs:12`、`chat/factory-execution-adapter.mjs:138`、`chat/organization-governor.mjs:264`、`chat/triggers.mjs:1`、`chat/session-goal.mjs:19`、`chat/project-memory-store.mjs:1`、`chat/permission-policy.mjs:27`、`static/chat/organization-view.js:758`、`tests/test-retired-voice-routes.mjs:1`。文件行号是审计定位提示；固定提交优先于持续变化的工作区行号。
## 阶段交付记录

各阶段完成时记录设计决策、修改文件与提交身份、已有验证证据、未验证范围、风险和回滚方式。源码存在、功能启用、真实业务通过和发布可用分别记录；不使用源码数量或测试总通过数代替验收。

当前工作区增量和未验证范围见[实施状态](implementation-status.zh.md)，开始时提交与已有脏文件见[来源基线](source-baseline.zh.md)；原方案中的基线审计保留为历史记录。
