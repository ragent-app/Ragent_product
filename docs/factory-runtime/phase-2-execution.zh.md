# 阶段 2：确定性调度、安全执行与验收恢复闭环

状态：方案部分已落地，缺项与验证状态见 [实施状态](implementation-status.zh.md)。日期：2026-11-13。上位：[总方案](00-master-plan.zh.md)。前置：[阶段 0](phase-0-baseline.zh.md) 的执行门槛、[阶段 1](phase-1-work-graph.zh.md) 的模型协议。后续：[阶段 3](phase-3-team-control.zh.md)。

## 1. 阶段目标

让一个已经授权的真实任务链经过 Work Graph 派发到现有执行链，产出固定候选成果，依据既有证据验收并推进依赖；中断时可以按真实记录恢复。包含最小暂停/取消控制与基本验收，不能只做到“能启动多个 Agent”。

第一版优先单项目、有限岗位、可证明隔离的执行环境；不承诺跨主机调度。先固定运行选择，再逐步开放经过能力和权限检查的备用 Harness。

## 2. 工作包

### P2-01：单主 Scheduler 与硬约束准入

新增 factory-scheduler，定时或事件触发读取 ready 任务；采用稳定优先级与等待时间排序，依赖推进不唤醒 LLM。

检查能力开关、当前授权、契约版本、依赖里程碑、绑定、实际 Harness、隔离资源、容量、磁盘和预算。持久化“为何未准入”，区分等待资源和执行失败。

使用数据库 CAS/唯一约束防止多个 timer 或重启中的旧控制进程重复认领。生产只允许一个 active scheduler 实例；数据库原子认领仍必须正确，不能靠进程布尔值保证安全。设置公平取队和 bounded batch，避免大量历史任务拖慢服务。

容量覆盖实例、项目、组织、岗位和 Harness；保留审查/集成的可用名额。槽位必须关联实际活动绑定，不能仅靠临时计数；暂停确认前与未知执行仍按风险占用。

### P2-02：执行适配器与唯一派发链

新增 factory-execution-adapter，负责 `Work Item → Execution Binding → 单任务 Collaboration → Attempt / Run`。

1. 从受控契约构建计划，不接受 Agent 自报更大权限或内部标志。
2. 外层派发 operation 仅创建/查询 Collaboration；实际消息投递继续由既有 outbox 负责。
3. 持久记录规范 taskId 映射，处理旧代码 task ID 命名空间调整，不按字符串拼接猜关联。
4. Factory 单任务执行显式禁用额外的 Manager aggregation，完成观察使用 Attempt / Run 真值。旧 Collaboration 保留原有汇总语义。
5. 组织内已有 Managed Session 若忙碌，排队或建立新受控执行绑定，不能覆盖活动 Run 工作目录。
6. 关联字段贯穿 manifest、候选、ResultPacket 和事件；不要要求修改所有既有 Harness 内部协议。

### P2-03：隔离 Writer 和候选成果

阶段 0 定义的 Factory 交付模式在此实现：完成回调只提交候选，不调用旧自动 canonical 回写路径。

每个 executionEpoch 使用彼此区分的工作区或 staging 位置，记录 canonical 项目、baseCommit/基准摘要、输入依赖产物、允许路径和资源归属。隔离工作内容与执行身份兼容现有共享后端 broker，不要求每个任务各自启动 OS 进程或通用沙箱。已存在脏工作区不能自动 reset；不得把用户未提交修改当作 Worker 成果。

候选封存时记录 commit 或 patch digest、文件清单和内容摘要；确认旧进程不能继续修改被验收的对象。保留失败或返工的必要证据；清理只发生在归属、引用和保留期均确认之后。

这里复用 managed-writer 的路径安全验证，不继承其完成即回写/即丢弃 staging 的生命周期。worktree 隔离不代表 OS 权限隔离，执行的读写/网络/密钥约束仍由真实运行边界承担。

### P2-04：基本验收和最小集成门禁

Adapter 接收 Run 成功后进入 review，不能直接 completed。ResultPacket 与当前 contractRevision、executionEpoch、bindingGeneration、候选 digest 匹配才能被采纳；过期结果作为历史保存，不更新当前任务。

依据 criterion ID 的完整集合查证：可信检查记录、实际退出状态、源码/产物身份及需要的独立审查。没有可信检查时可在契约明确允许的范围采用人工验收，并标记其局限；不能伪造“测试通过”。

当任务依赖候选时传递固定成果引用；需要主线集成才能继续的依赖必须等待 integrated。阶段 2 至少提供受控的单候选集成入口，禁止 Agent 自行写回 canonical；多候选 PR/发布流程扩展在阶段 4。

集成授权绑定候选及当前目标基准。统一目标资源锁、expected version 检查与操作日志，旧执行无权执行集成。目标变化则 blocked 或重新生成合并候选，不能用先前审查覆盖新内容。

### P2-05：预算与执行取消

在现有 Governor 上增加组织跨修订累计口径、任务预留和实际结算关联，控制并发槽位而非只记录累计 agents。

usage 未知时保留 pending，重试结算不能重复记账；退回预留不抹除实际已消费成本。未证实执行结束的预留不得仅因 TTL 到期就当作无消费释放并无限重派。

最小用户控制支持暂停新准入、请求停止任务和取消任务。优先持久化命令，使用现有受控取消/interrupt；收到确认后释放容量。取消期间收到成功结果时，以命令顺序、epoch 和副作用事实裁决，不能吞掉已发生变更或把旧结果重新提升为完成。

### P2-06：恢复与迟到事件

| 中断位置 | 恢复依据 | 禁止行为 |
| --- | --- | --- |
| claim 已落盘，Collaboration 未创建 | 派发意图和稳定键 | 无条件新增第二个 task |
| Collaboration 已创建，外层未回写 | 创建键/绑定索引查询 | 因缺 runId 再开一份 |
| 消息已受理，Attempt 未观察 Run | 现有 requestId/outbox/Run 查询 | 忽略已有 outbox 直接 sendMessage |
| Run 已终态，Packet 未关联 | canonical Run 事实和 Packet 唯一 runId | 从文本猜成功或构造假的执行证据 |
| 候选已封存，验收未提交 | 候选摘要和 acceptance operation | 重新执行实现工作覆盖候选 |
| 已完成外部集成，响应丢失 | operation、仓库 head、提交身份 | 未查询就再次应用补丁 |
| 旧 Worker 可能仍活着 | 活性/终止/隔离证据 | 租约过期立即重派冲突写入 |
| 已记录验收，投影未刷新 | 业务事实及事件 cursor | 用旧 UI 状态回写任务 |

保留有限重试、退避和死信/人工处置入口。恢复查询分页，不能只查当前最近几条事件。启动扫描与常态 reconciler 幂等，职责不重叠。

## 3. 修改边界

建议新增 scheduler / execution adapter；扩展 Work Graph、Collaboration、ResultPacket 关联和 Governor；修改 Factory-owned Managed Writer 完成路径；复用现有 Run/Session 和认证审批能力。

不重写 Harness；只有确需传递执行归属、确认取消或能力限制时修改直接边界。对正在并行变化的 run-launcher、provider-contract、审批文件，实施前对齐实际最新代码。

## 4. 验证依据

可选择已有 `test-collaboration-orchestrator.mjs`、`test-collaboration-store.mjs`、`test-collaboration-s6.mjs`、`test-run-admission.mjs`、`test-workspace-leases.mjs`、`test-mutation-coordinator.mjs`、`test-managed-writer.mjs`、`test-result-packets-v2.mjs`、`test-phase-gates.mjs`、`test-orchestration-reconciler.mjs` 和组织 S23/S25 检查，限于与实际修改相关的既定断言。

真实业务证据使用用户已授权的实际项目和已有需求/检查。选择已有清晰验收条件、范围有限、可隔离的工作；不预设虚构“自动更新已通过”示例。若尚无合适实际任务或环境，则只报告实现完成与未验证部分，不制造替代测试。

## 5. 退出条件

- 一个真实 Work Item 可跨 Run 生命周期保留，并把候选与实际执行准确关联。
- 下游仅在明确里程碑成立后启动；重复通知不会重复派发或验收。
- 未验收候选不自动写主工作区；冲突、未知副作用和旧运行均有明确阻塞方式。
- 取消/暂停有请求状态与确认状态，结果不会因晚到覆盖新执行。
- 预算预留和结算可追溯，汇总不依赖每任务启动 Manager。
- 恢复证据能区分逻辑对账与真实服务/进程恢复；平台缺口仍明确标记。

不以跑完一组模拟测试代替上述业务条件；新增测试仍须另行许可。

## 6. 回退

关闭新任务准入，保留 in-flight 的观察、对账和用户取消。未知运行不自动转到 legacy，也不删除候选或解除旧写入风险。对已生成的 Factory 数据继续按新协议读写直到安全收尾；不能简单部署旧二进制让它处理自己不理解的 ownership。

向阶段 3 交付真实状态、控制 operation、可用能力和 API；向阶段 4 交付候选与最小集成协议。
