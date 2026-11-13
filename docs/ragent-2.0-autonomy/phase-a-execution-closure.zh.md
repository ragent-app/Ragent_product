# 阶段 A 基线固定和执行收敛

[返回总览](README.md) · [下一阶段 B](phase-b-responsibility-events.zh.md)

目标：先让现有 Factory Runtime 的任务执行、依赖推进、恢复和验收形成可解释的闭环，为持续责任提供可靠执行基础。本阶段属于 MVP 前置工作。

开始前核对当前提交、已有修复和并行任务。原审计曾观察到组合验证相关模块持续变化，不能重复实现或覆盖这些工作。以下缺口来自原基线，实施时逐项确认是否仍存在。

## 工作包和顺序

| 工作包 | 交付内容 | 后续依赖 |
| --- | --- | --- |
| A1 基线与归属 | 固定源码身份、模块状态、调用入口和并行修改归属 | A2–A6 |
| A2 图推进 | 依赖解除、候选摘要绑定与受限推进命令 | A5 和阶段 C |
| A3 执行收敛 | 失败、取消、无回执、只读审查结果及资源释放语义 | A4、A6 |
| A4 恢复边界 | 旧派发意图接管、只读观察与死信后行动控制 | 阶段 B、C |
| A5 验收接线 | 明确人工与自动验收入口、真实检查证据和模板版本 | 阶段 C |
| A6 预算与运行配置 | 预留失败处置、可信结算、未知用量处理和准入状态展示 | 阶段 B、C |

## 必须前置处理的执行缺口

以下是静态路径可见的问题及其后果推断，不是已完成故障注入的运行结论。

### 依赖任务尚不能完整自动推进

`ApproveContract` 会把有未满足依赖的任务置为 `blocked`；`listFactoryReadyWork` 只查询 `ready`。Scheduler 会对 blocked 项调用 adapter，但 adapter 在没有执行绑定时直接返回。上游验收完成后，没有看到自动把纯依赖阻塞项推进为 ready 的消费路径。当前可通过显式 `RetryWork` 重新计算依赖，但后台 scheduler 的服务授权不包含该命令。

另外，`instantiateFactoryWorkflow` 将 `candidate_ready` 依赖的摘要置为 null，后续 eligibility 和 validation workspace 均要求固定候选摘要。不能仅把前驱标为完成就自动放行审查；必须明确候选产生后由哪个受限命令绑定摘要、核对合同版本并推进后继。

改造：增加 Work Graph 内部的依赖对账命令，按前驱里程碑、当前合同和候选代次更新。区分依赖解除与执行重试；不要为了唤醒任务消耗重试次数或重新授权整个合同。证据：`work-graph.mjs:43,74,81`、`factory-control.mjs:33`、`factory-scheduler.mjs:37`、`factory-execution-adapter.mjs:200`、`factory-workflow.mjs:47`。

### 失败和取消尚缺完整的终态映射

`updateFactoryBinding` 提供 `fail`，但基线 adapter 的 reconcile 主要处理成功封存、绑定 Run、撤权和请求停止，未调用该失败转换。普通失败、派发失败且没有 runId、自然取消等路径不能仅靠成功分支收敛。暂停/取消分支又要求 Run 与 Attempt 同时为 cancelled；若任务在取消请求到达时已经 completed 或 failed，需要另行判断真实结果和业务取消语义。

改造：明确每一类 Attempt/Run 结果如何更新 binding、Work Item、容量和预算。缺失 Run 不能视为未执行；外部效果不明进入可查询的 unknown。基线 adapter 成功分支还依赖 `sourceContext.managedWriter`，需确认只读审查任务是否能提供相应候选或专用审查结果，避免复用“写任务产物”要求阻塞只读任务。证据：`factory-control.mjs:14`、`factory-execution-adapter.mjs:200` 及其成功/取消分支。

### 派发恢复需要可验证地接管旧意图

Collaboration outbox 在实际发消息前重新检查 Factory fence，这是应保留的边界。但持久 `factoryExecution` 包含原 scheduler 的 ownerToken 和 leaseGeneration；重启后的调度租约发生变化，而已有 Collaboration 会继续携带原上下文。`dispatchFactory` 还要求同幂等键上下文完全一致。

改造：区分“尚未受理”“已经受理但回执未写入”“效果未知”。先按原 requestId 查 Run/回执；确实未受理时，以持久接管操作更新可派发授权并重新检查政策，不直接替换业务幂等键，也不放松 fence。证据：`collaboration-orchestrator.mjs:685,1420`、`factory-execution-adapter.mjs:64,200`。现有保守拒绝不等于已经实现重启续行。

### 死信状态与继续观察语义不清

`recordFactoryReconciliationFailure` 达到上限后写 `dead_letter`，但 `factoryReconciliationDue` 只判断时间，仍允许后续 reconcile。adapter 的 reconcile 在特定条件下会再次 dispatch，因此这里不能把“继续观察”和“继续行动”混在一起。

改造：死信后继续读取真实执行状态，停止产生新副作用；恢复需要显式命令或明确政策。错误次数、下一次只读观察时间、允许再次行动的条件分别表达。证据：`factory-reconciliation.mjs:15,20`、`factory-scheduler.mjs:37`、`factory-execution-adapter.mjs:210`。

### 工作流和验收仍有人工接点

Factory workflow 编译器明确不分配执行人、不批准合同、不启动工作；默认模板版本为 1，版本 2 才要求独立审查。模板多项验收是 `manual`。注册检查和检查验收也要求 owner，基线路由没有把全部检查、集成入口接成后台工作流。仅存在这些模块，不能证明一次授权后可以自动完成完整流程。

改造：保留人工验收；为明确授权的模板增加受限的 workflow admission 和证据处理主体。该主体只能实例化固定模板、选择满足约束的节点、接受真实检查结果，不冒充 owner，不允许模型把人工审批条目改成自动通过。

注册检查当前只接受特定 `codex-app-server-json` 的显式 provider exit code 与 cwd。MVP 要按实际证据能力选 Harness；Claude 等通道可以执行任务，不代表自动获得相同检查证明。证据：`factory-workflow.mjs:33,40`、`factory-checks.mjs:32,40`、`factory-acceptance.mjs:47`、`work-graph.mjs:14`、`router-factory-routes.mjs:42`。

### 预算有可靠基础，但尚不能承诺严格每日费用封顶

Factory 已原子预留且跨 revision 累计，不能再列作待从零实现。当前 reconcile 只在拿到归属于该 Run、同时含实际成本和 Token 的 provider 总量事件后结算；缺失时一直保留预留，是保守行为，也会形成长期占用。预留量本身不限制一个正在运行的模型实际消耗；实际超额仍需要如实入账。

改造：补预算预留失败后的任务处置、已证实未启动时的释放、缺失用量的核实入口。每日预算明确时区、窗口、跨日归属和责任范围；保留组织总预算。若 provider 不支持强制限制单次成本，界面明确展示估计/未知及超额处置，不能把预留说成硬上限。证据：`organization-governor.mjs:264,334,384`、`factory-execution-adapter.mjs:16,162,228`。
## 范围与交付

复用 Work Graph、Factory Scheduler、Collaboration outbox、Organization Governor、ResultPacket 和权限执行链。修复在现有领域入口完成，不创建第二套执行状态机或后台派发者。每日窗口的完整扩展留在 D；本阶段先解决当前预算生命周期和准入行为。

交付物包括六项工作包的设计与代码变更记录、执行/验收状态映射、恢复和预算处置协议、现有检查证据、未验证范围与回滚说明。

## 退出条件

- 已授权工作流能形成真实候选、匹配该候选的检查证据与明确验收。
- 依赖满足后能通过授权的领域转换推进；依赖解除不混同重试。
- 失败、取消和未知结果均有可查询状态及下一步处理者。
- 重启接管不绕过 fence，不重复派发已经受理的工作。
- 关闭新准入后，仍可观察、取消和对账已有任务。

遵守[共用验证与回滚规则](verification-and-rollout.zh.md)。本文件没有把上述条件标为已通过；只选择与实际修改相关的既有可信检查，新增测试须另获授权。

## 实施记录（工作区，未验收）

开始审阅时 HEAD 为 `64014e687407514f57856a6e7005a1c505483a3e`，随后并行工作将 main 推进至 `b6f8b681`；工作区同时存在其他未提交修改，本记录不是发布证明。已实现的领域变更包括：持租约的依赖解除和工作流候选固定；失败及取消结果的部分终态映射；死信后只观察和单独的 owner 恢复命令；预算预留失败的未启动与未知结果区分；责任授权下的模板准入以及认领、发送前授权复核。人工验收仍须 owner 执行：先核实并验收只读审查工作，再验收其源候选；已执行的真实注册检查才可作为检查条目的证据。责任授权依赖同库责任事实和服务器读取的项目仓库事实；文件系统检查与外部发送并非同一事务，检查后的外部变化不能靠数据库回滚。

日预算使用 Governor 现有组织预留和结算事务附加责任窗口；窗口按预留时刻、固定 IANA 时区的日期归属，未知用量保留预留，实际超额如实入账。预留是准入估计，不能阻止 provider 在运行中实际超支。时区首次使用后变更暂拒绝，需要明确迁移协议。

静态审阅和 `node --check` 仅证明相关模块语法可解析；未执行真实业务流程、重启故障注入或阶段退出验收。旧派发仅能按原请求身份正向核实已有 Run，查无结果仍属 unknown，不能据此自动重派；审查和检查的实际业务闭环尚未验收。未找到可信的完整业务证据，不应将本阶段标为通过。关闭新准入后保留既有观察和取消路径；恢复操作须 owner 明确发起。回滚先关闭新准入和派发，保留数据库、历史任务、候选、预留及外部结果证据；已发生的外部操作不能通过数据库回滚撤销。
