# 剩余工作与验收顺序

主体审计基线：`main` 提交 `9de27f1f6dab94ec54cbd81d346bd36d489988ed`。审计期间 `main` 推进至 `48cdfdaea4866b9c29d8fff490323de71991f2d3`，其中新增受开关和签名构建证明约束的 GitHub Release provider；该增量仅核对源码及提交身份，尚未真实发布验收。工作区其他未提交修改不计入上述基线。本清单区分源码、真实验收和可选扩展；GitHub CI 是一个适配示例，项目资料报告和本地代码也是目标场景。没有以百分比或测试数量推断完成度。

后续工作区增量增加时间触发绑定、正向执行对账、预算事实展示和有限局部修订源码；这些增量的提交身份以实际提交记录为准，尚未通过真实运行或重启验收。

截至 `ecaad841085f944c43a4fd08a42256dfbb97726c`，已提交的后续增量另包含受授权项目事实引用、Android 组织离线视图、只读 sandbox 配置和 Factory 并发设置源码；这些不等于完整 User Memory、跨平台隔离证明或真实设备验收。正在并行编辑的未提交内容不计入该基线。

## MVP 代码收尾：延期须明确缩减范围

- **Trigger 责任桥**：时间绑定与可选周期，以及仅组织根会话 `run_terminal` 的事件绑定已接入源码。事件从绑定创建后尽力扫描保留索引，发现前删除或未索引的执行可能遗漏，只有发现并入库后才持久；回执满时需核对并重新绑定观察起点。暂停期间错过的时间触发需恢复责任后由 owner 明确恢复。其他事件来源、真实投递与重启验收仍缺。依据：`chat/responsibility-trigger-bridge.mjs`、`chat/responsibility-trigger-events.mjs`、`chat/triggers.mjs`。
- **资料变化指纹**：可选的 `committedGitChangesOnly` 仅对周期/时间唤醒比较本地已提交 Git HEAD 和分支；不覆盖未提交、未跟踪、忽略文件或外部资料，瞬时变化可能遗漏。手动和执行结果唤醒绕过，观察不可用时等待。完整资料变化检测仍缺，真实水位与重启验收未完成。依据：`chat/responsibility-git-observation.mjs`、`chat/responsibility-decision.mjs`。
- **原可靠性约束与范围决定**：权威否定受理查询及安全自动恢复、运行成本硬封顶尚未完整实现。未知时不得强行重派；若 MVP 接受人工核实或只承诺准入预算，须明确记录范围决定，否则须先补可证明的对应能力。目标失效后继续执行的安全栅栏仍须验证。

## MVP 真实验收与放行

1. **固定可验收环境和授权。** 选定用户明确授权的真实非 CI 项目、owner、组织节点、Harness 和 provider；核对当前部署提交、项目根、作用域、预算与开关。项目报告目前授权整个项目读取；文件只读不证明网络隔离，要求禁网而不能证明时必须拒绝。完成条件：记录真实身份、权限、节点能力和不可用原因，未授权操作不能被准入。依据：`chat/responsibility-providers.mjs`、`chat/factory-responsibility-admission.mjs`。
2. **跑通一项真实责任和人工验收。** 使用现有入口完成目标/政策确认 → manual 或 interval wake → 真实 Run/ResultPacket → 计划与范围审阅 → 候选、独立审查和已有可信检查 → owner 验收；先以项目报告为首例，再按需要选择本地代码或 CI。完成条件：每步能追溯同一责任、版本、Run、结果和授权；模型摘要不能代替证据，单个 workflow 完成不等于长期责任完成。依据：`chat/responsibility-decision.mjs`、`chat/responsibility-plans.mjs`、`chat/factory-acceptance.mjs`。
3. **证明中断和停止可处理。** 以真实授权任务核对重启、断线、重复唤醒、撤权、暂停/取消及先完成后取消；检查旧代次不能继续提交、外效未知时不重复派发。当前缺权威否定受理查询时保留 `unknown` 并人工核实；若 MVP 要求自动接管重派，须先实现可证明未受理的事实和 lease fence。完成条件：每个在途动作可查询或明确交人工，停止请求不显示为已经停止。依据：`chat/factory-reconciliation.mjs`、`chat/responsibility-service.mjs`。
4. **核对预算及回滚。** 验证实际 provider 用量归属、每日窗口、超额和重启对账；缺用量保留预留。现有预留/结算不是运行费用硬封顶：MVP 须明确选择只承诺准入预算，或先接入执行器/provider 可证明的硬限制后才提供硬封顶承诺。确认关闭责任和 Factory 新准入后仍按配置观察、取消与对账，已发生外效不能靠回滚撤销。完成条件：记录使用量或未知状态、能力选择、操作回执和回退结果。依据：`chat/organization-governor.mjs`、[验证与回滚](verification-and-rollout.zh.md)。
5. **完成实际客户端和通知验收。** Web/Android 需用真实 owner、审批与任务状态验证生命周期、计划、活动和成果；Android 组织模块离线 Kotlin 编译已通过，但设备行为未验收。Web Push 默认关闭，须逐责任 opt-in 和已认证设备绑定；验证绑定、撤销、重复、冷启动和多窗口，provider 接受不等于已读。Android FCM 责任通知未接入。完成条件：关键待决事项和未知状态可读、请求与实际停止分开，且无未经授权的通知。依据：`static/chat/organization-view.js`、`chat/responsibility-notifications.mjs`、`static/sw.js`。

代码收尾和上述真实证据均需完成，除非明确决定缩减相应 MVP 范围；这不意味着必须先支持所有设备、连接器或自动发布。真实项目、Harness、provider、CI、重启和推送尚未通过本轮业务验收；源码和语法检查不等于上线。

## 原 Phase 0–5 对照

| 原阶段 | 已有基础及剩余完成条件 |
| --- | --- |
| **0 底座** | 真实目标平台的 Harness、隔离、授权和运行能力尚需证据；建立能力矩阵，未知能力保持拒绝。 |
| **1 工作图** | 持久图、依赖与目标修订已有；单个已停止且非终态根工作项可预览修改 objective 并按下游闭包失效，全局目标变化仍整 Goal 保守失效。真实依赖、版本和恢复待验证，通用精确复用不是 MVP 必备。 |
| **2 执行** | 候选、审查、检查、恢复和取消已有源码；完成上面的真实执行和中断验收，未知受理与用量不能推断成功。 |
| **3 团队与客户端** | 组织、换绑、消息和 Web/Android 控制已有基础；最新提交补充托管 Agent 身份冻结校验，仍须验证换人/换 Harness 后权限代次、合同、旧外效及历史连续性。 |
| **4 工作流与交付** | 项目报告、受限代码公式及 CI 示例已有；证明真实候选、独立审查、检查和受控集成。GitHub Release provider 的受限源码已提交，但未真实验收；PR 或其他自动发布另行决定。 |
| **5 灰度验收** | 按目标平台取得重启、授权撤销、监控和回滚证据；备份和跨库一致性有边界，不能声称外部副作用随数据库回滚。 |

原计划详见 [Factory 阶段 0–5](../factory-runtime/00-master-plan.zh.md)；本目录的 A–F 是自治层的实施分解，不是一组可互换的阶段编号。

## 后续扩展与待决事项

- **通用任务与事件**：目前仅报告、本地代码和 CI 适配，不支持任意应用/连接器自动执行。通用事件过滤/水位及更多适配器按实际用途逐项补可信观察、资源授权、动作回执和恢复。依据：`chat/responsibility-runtime.mjs`、`chat/responsibility-events.mjs`。
- **记忆与组织**：补不同 fact ID 的同义冲突处理、User Memory 来源/更正/删除完整体验及真实恢复；验证执行者替换和 handoff。当前记忆写入默认关闭，撤销事实不是物理擦除。依据：`chat/responsibility-context.mjs`、`chat/project-memory-store.mjs`。
- **Goal-DAG 精确影响**：当前仅支持单个已停止且非终态根工作项 objective 的局部修订及下游闭包失效，全局目标变化仍整个 Goal 保守失效。原 Phase 3 更一般的精确影响及可证明子集复用仍属 Full 代码缺口。依据：`chat/factory-goal-revision.mjs`。
- **跨设备和连接器**：单权威远端与固定授权单文件传输已有源码但未做双实例验收；设备隔离/授权不能从在线状态推断。邮件未知效果需人工核查，Calendar 仅特定事件身份支持查询回执；GitHub/Gmail/Calendar/Drive 尚非完整统一动作能力矩阵。依据：`chat/remote-factory-source.mjs`、`chat/remote-file-transfer.mjs`、`lib/connector-action-dispatcher.mjs`。
- **语音和移动体验**：当前是手动 ASR 草稿、同一路径审阅及显式 TTS；免手持连续对话、打断/跨设备续接和 Android FCM 按产品需要继续，不能把现有草稿入口描述为完整语音自治。依据：`android/feature/organization`、[阶段 F](phase-f-voice-experience.zh.md)。
- **交付与发布**：GitHub Release 的已提交受限 provider 仍需真实签名构建、授权、发布和查询恢复证据；PR 的创建、更新、合并及可查询恢复、其他正式 provider、跨库完整备份、多 Harness/平台灰度和成本硬限额均按目标另行决策；无 provider 强制能力时不能保证硬封顶。依据：`chat/factory-github-release.mjs`、`chat/factory-release.mjs`。

验证遵循 Evidence First：优先复用现有可信检查和真实业务证据；新增测试、mock 或测试基础设施须另获用户许可，不以自行构造的结果代替验收。
