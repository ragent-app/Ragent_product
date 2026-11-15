# 提醒交付整改：兼容与证据边界

日期：2026-11-13

触发器的 `status` 是调度交接状态。`delivered` 和 `deliveredAt` 不证明目标会话已有回复，也不证明用户已读。新的 `deliveryResults` 按 occurrence 保存请求、运行、交付结果与尝试信息；`executionState` 与 `deliveryState` 分别表达运行及发布结果。旧记录缺少可靠发布证据时，交付结果为 `unknown`。触发器 API 返回这些字段；CLI 展示最新结果，首页显示近期失败。周期任务各轮结果应独立解释，不能将下一次排期当作上一轮成功。

结果数组最多保留 64 条，满时可移除最旧的非待处理且不再跟踪的结果；它不是长期审计归档。底层 Run 和会话事件可用于进一步调查，但受各自现有保留策略约束。需要长期保留所有 occurrence 和尝试的场景仍需独立归档方案。

已受理但结果暂不能确定的 occurrence 可保持 `unknown`，以 `tracking` 继续对账；`effectiveRunId` 标识可关联的实际 Run，`observationError` 记录观察失败，不能把缺少持久发布证据视为成功。容量保护优先保留 pending 和仍在跟踪的结果；64 项均不可淘汰时，新 occurrence 明确失败，避免丢失活动关联。这些新增跟踪行为仍需在完整 Windows 执行环境中现场验收。

启动错误按 provider 准备、supervisor 拒绝与通信阶段保留信息；请求可能已交接但没有确认时，不应退回另一启动路径。MCP 就绪诊断属于对应 Run 的独立证据，不改变必需工具校验或默认超时。CLI 身份诊断只记录 capability 字段存在性，不记录值。

固定文字直接交付已作静态评估：会话存在追加 assistant 消息的能力，但当前未确认基于 occurrence 的原子去重及崩溃恢复契约，因此未接入。状态事件不是聊天回复，也不是其他渠道的回执。不得通过系统通知代替用户指定的聊天回复。

用户报告的事件尚缺原始 trigger、Run、发布记录和授权导出的日志，无法确认这次事故的具体路径、provider 底层原因、owner-bootstrap 注册接口或 MCP 超时根因；这些事项需使用授权诊断入口独立核实。本次不部署、不重启服务、不重放历史提醒。旧数据和审计记录应保留。

## 本次变更与检查

- `chat/triggers.mjs`：区分交接、运行与发布结果；记录关联及有限的近期尝试；恢复待处理结果跟踪，并对状态事件的写入失败保守处理。
- `chat/run-launcher.mjs`、`chat/runner-sidecar.mjs`、`lib/ragent-http-client.mjs`：保留启动阶段、身份诊断和 MCP 就绪线索。
- `lib/trigger-command.mjs`、`chat/home-projection.mjs`：展示交付状态和近期失败。
- 静态审查与相关 JavaScript 语法检查已执行。已有 `tests/test-home-projection.mjs` 和 `tests/test-trigger-command.mjs` 通过；这些检查不证明新增交付路径的业务正确性。

本次变更未针对原始事件进行复现或运行数据核验，也没有新增测试。直接交付、长期审计归档和基于实际事件的根因调查仍需后续工作；这些不应表述为已经完成。
