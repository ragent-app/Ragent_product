# 共用验证灰度和回滚规则

[返回阶段总览](README.md) · [架构约束](architecture-and-boundaries.zh.md)

本文件适用于各阶段退出检查和 MVP 发布。下文“本次源码审计”及检查记录均指原完整方案的审计，不代表本次文档拆分执行了测试，也不代表当前源码仍处于相同状态。

## 验证和发布证据

采用六列能力基线：源码存在、生产调用接线、默认/实际配置、现有可信检查、真实业务验收、发布版本。相比原方案，单独增加“接线”和“实例配置”，因为本次发现多个模块存在但未形成自动调用闭环。

| 证据范围 | 当前可以说什么 | 不能据此推出什么 |
| --- | --- | --- |
| 本次源码审计 | 固定提交的控制流、表结构、权限边界及调用缺口 | 真实服务安全、跨平台通过或已经发布 |
| 现有 Factory implementation-status | 文档记录部分旧 Collaboration/投影检查通过，phase-gates 和 autonomous-organization-s22 有失败记录 | 本轮已重跑、失败已经修复，或新 Factory 已通过 |
| Factory 专用验证 | 本次在 tests 中未找到直接引用核心 Work Graph/Factory scheduler/adapter 的专用检查 | 无需验收，或可以用旧测试的总通过数代替 |
| 客户端源码 | Web/Android 已有基础任务入口 | 真机、断线重连或完整业务链已验收 |
| 发布/备份模块 | 有协议和工具实现 | 实际 provider 已发布、跨库恢复已经验证 |

遵守工作区 Evidence First 规则：本次不新增测试、mock、探针或演示数据。后续先实现，再审阅直接依赖，选择既有可信检查。新测试和故障注入基础设施需要明确授权；不把原文“180 个场景”当作已批准任务。可靠性验收应围绕实际系统断点，而不是凑数量：事件持久后、工作意图提交后、Run 受理未回执、候选封存后、审批后目标变化、外部写出后未收到回执。

现有检查按改动选择：Trigger 对应 `test-http-triggers.mjs`；旧执行基础对应 `test-collaboration-store.mjs`、`test-collaboration-orchestrator.mjs`；账本对应 `test-orchestration-store.mjs` / `test-orchestration-reconciler.mjs`；组织预算和恢复需核对 S22/S23 等既有场景实际覆盖；权限对应既有 permission-policy、capability-grant 和 execution-boundary 检查。旧 fixture 不符合新行为时，先核对契约变更，不擅改 expected output 让检查变绿。

保持 Factory 默认不准入新工作。现有控制开关检查 `RAGENT_FACTORY_CONTROL_ENABLED === 'true'`，scheduler 开关检查 `RAGENT_FACTORY_SCHEDULER_ENABLED === '1'`，组织白名单、owner 授权来源和 Governor 另有前提；这应统一配置解析并在能力页展示拒绝原因。关闭新准入后继续观察已有工作，避免开关关闭导致状态失联。

发布先单项目、单组织、单权威实例、经验证的 Harness/平台组合。灰度前记录数据库与产物备份边界；回滚先关新事件准入和新派发，保留读取、取消和对账。已执行外部操作不靠数据库回滚撤销；unknown 保留人工核实。加法迁移不得删除历史 Session、Run、候选或旧责任证据。
## 每阶段的证据交付

| 项目 | 应记录的内容 |
| --- | --- |
| 源码身份 | 审阅或运行的提交、相关未提交修改、配置前提 |
| 实现范围 | 已完成行为、修改入口、复用边界及未完成项 |
| 已有检查 | 实际执行的检查、结果和适用范围；未运行如实注明 |
| 真实业务 | 实际事件、执行、审批和结果证据的关联；没有则标未验证 |
| 风险与恢复 | 已知失败、未知外部结果、回滚步骤及不能撤销的效果 |

阶段文档里的退出条件是验收要求，不是已有结果或新增测试授权。对于没有可靠 oracle 的部分，保留未验证状态，不创建替代测试来证明进度。
