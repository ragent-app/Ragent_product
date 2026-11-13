# Factory Runtime 实施状态

源码：`G:/AgentoC/Ragent_product`，`main`。原始核查 HEAD `3628b2ef5f5627fe2118bda40691150c8d1da74f`；方案文档提交 `18250b9ccdb50ec05bd30d44cf2ff684a623b00a`。工作树含其他未提交修改，以下为本次工作状态，不把代码存在等同于真实运行通过。

| 阶段 | 实施情况 | 审阅与验证 |
| --- | --- | --- |
| 0 现状与前置 | 执行代理报告：从冻结计划恢复 managedSessionId，并核对组织和绑定；返工上下文持久化到冻结 policy；Gate 决策按持久记录回放 | 进行中；尚无真实环境验证 |
| 1 Work Graph | 加法表与独立迁移记录、契约/候选/决策不可变、CAS/命令回执、依赖图、控制状态、版本栅栏、分页、调度租约和容量检查已编写；候选、验收和 integrated/released 里程碑须服务端可信验证器 | 静态审阅进行中；新增模块语法检查通过；已有 Collaboration Store/Orchestrator 检查通过但不覆盖 Factory；暂停后恢复需要显式 RetryWork |
| 2 执行 | 已编写调度、受控候选及工作区受控应用；共享后端 broker 保持为支持的架构 | 自动调度的启动接线、预算与候选证据、集成及恢复尚未完成或验证；禁止视为真实可用 |
| 3 团队指挥 | 代理报告：owner HTTP 列表/详情/命令/回执、开关关闭时的查看及暂停/取消、Web/Android 基础任务控制、信息消息及组织投影接线已编写 | 节点消息能力、回执/回复和生命周期已有源码接线；新增节点能力、活跃授权撤销、真机与重连未验证 |
| 4 工作流与交付 | 已编写限定输入的版本化研发流程提案编译、图生成与模板/输入摘要固定；只创建 proposed 工作，不自动授权或执行 | 尚未以真实项目证明流程；人工验收依赖真实候选/Run/Packet；自动检查依赖尚未实现的候选派生工作区来源与前后内容校验；受控工作区应用不等同 Git 集成；Git commit/PR、发布链未完成或未验证 |
| 5 灰度与验收 | 尚未开始 | 无真实环境、部署、重启、跨平台或回退证据 |

本次未访问生产数据库、调用真实 Harness、重启服务、部署或发布，未创建测试。完成项需后续审阅及适用的现有可信检查支持。模板来自本仓库方案而非已证实的业务运行流程，不能将其称为已验证模板。

Windows G: 隔离环境既有检查：`tests/test-collaboration-store.mjs`、`tests/test-collaboration-orchestrator.mjs` 通过；`tests/test-phase-gates.mjs` 在约 30 条前置断言后于共享 `run-publication-contract.mjs:21` 返回 INVALID_ARGUMENT，原因尚未确定，返工部分未到达。这些结果不证明新 Factory、真实 Harness 或生产恢复。

团队控制既有检查：`tests/test-chat-organization-view.mjs`、`tests/test-organization-projection-v2.mjs`（29 项断言）与 `tests/test-session-control-capability.mjs`（旧 root 范围）通过；这些不覆盖新增节点消息能力或真实执行。Android 离线 `:app:compileDebugKotlin` 在修正既有 G: debug keystore 路径及参数后通过；此前两次在编译前因签名路径及参数引用失败。该结果不证明 APK、设备或重连能力。上述检查在原基线与并行未提交修改组成的工作树上执行，不代表已发布版本。

工作流预算按调用者明确提供的 `maxCost`、工作项数量与最大尝试次数计算每次成本预留；最终准入仍由组织 Governor 实际限额与授权决定，不假定预算充足。审查任务的候选输入范围与写入授权分别表达，复用共享 broker 的任务级策略。
