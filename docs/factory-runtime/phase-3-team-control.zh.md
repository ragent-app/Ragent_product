# 阶段 3：长期团队、动态指挥与 Web / Android


2026-11-14 补充：受控 Steering 源码已提交，非支持 provider 为 unsupported；本地 dispatch 的 node/work 范围上下文接入源码已提交，截断时 freshness 为 unknown_truncated。签名远端委派也有不含收件箱的有界任务摘要；owner 可将已有项目事实显式绑定单一任务，但远端携带知识引用目前拒绝，完整长期记忆尚未完成。Android 编译证据不代表真机或重连验收。同一事务确认尚无 Collaboration 或派发身份时可追加新的不可变快照；已冻结输入不改写。发送前核验不能保证跨数据库与真实发送原子。
状态：方案部分已落地，缺项与验证状态见 [实施状态](implementation-status.zh.md)。日期：2026-11-13。上位：[总方案](00-master-plan.zh.md)。前置：[阶段 2](phase-2-execution.zh.md) 的真实状态与受控执行。后续：[阶段 4](phase-4-delivery.zh.md)。

后续已提交单专家只读咨询、实际 Run 绑定意见与未发送请求恢复，以及受限单节点 reviewer 的 owner 授权修订；咨询和修订仍缺真实运行证据。未知派发不能靠 lease 过期重发，预算缺可信用量时仍保留预留。

## 1. 目标

用户通过已有组织界面和新增任务视图持续管理团队：查看岗位及任务、明确知道阻塞与待决事项、发送问题、调整优先级、暂停/取消、修改契约或成员配置；控制结果真实可确认。

组织不因某次聊天结束而消失。岗位持久存在不意味着每个岗位持续运行 Agent。尽量复用已有 organization-view、Android organization 模块、Projection 和远程传输。

## 2. 工作包

### P3-01：组织身份与 Session 生命周期

沿用 nodeId/stableKey 和 role_instance；补充角色职责、能力需求、默认运行偏好、允许的替代 runtime、岗位容量及绑定历史。配置和实际执行选择分开显示。

将 organizationId 作为正式入口，兼容 rootSessionId 查询。保留历史 root 关联，新增入口绑定操作；清理/归档会话时保护活跃组织引用。禁止用户仅删除聊天就级联删除目标和任务；归档团队须检查活动执行和待处理操作。

不因模型切换重建岗位。创建/替换 Session 通过现有操作日志和 bindingGeneration；旧会话停止/隔离后新绑定才承担写入任务。空闲岗位不启动 Run；现有提前建立的空 Session 可保留，按需实体化作为渐进优化。

### P3-02：组织关系修订

MANAGES 继续单父无环；新增 REVIEWS / CONSULTS 分类型边与授权范围，不把 Reviewer 加进 Backend 与 QA 的管理链来表达顺序。

新增强制审查要求时，同时变更工作流/任务验收策略，并生成影响分析：哪些候选需要补审、哪些待执行任务采用新契约、哪些运行继续旧版但成果暂不可接受。组织图变化本身不能自动修改所有旧任务。

审批按已授权范围执行：用户预授予 Manager 的普通调度操作无需重复确认；权限扩大、总目标变更等超范围操作产生审批。独立审查至少要求审查主体不等于被审查的执行主体，且实际有效 Grant 无写入目标权限。

### P3-03：消息协议与必须答复请求

保留 Typed Envelope 作为投递机制，扩展消息正文记录和引用关系，至少包含 messageId、sender、recipientNodeId、workItemId、correlationId、请求类型、回复关联、创建时间、可见范围；必要时增加 respondBy。

协议区别：

- 普通信息：入邮箱，下次上下文带入；不必新开 Run。
- 咨询：可排队为受预算约束的只读任务，复用现有 Consultation 能力；能力不满足时明确拒绝。
- 必须答复：跟踪 requested / delivered / answered / overdue，必要时升级；超时不自动宣告对方同意。
- 阻塞报告：可提交结构化阻塞提案，只有工作图命令成功才改变任务状态。
- 控制指令：进入 Factory Control，不以发送一条自由文本冒充暂停、取消或改约。

沿用 payloadRef 限引用的限制；消息正文不含凭据，不跨项目自动广播。ack 表示协议消费状态，不等于任务完成或问题已回答。

### P3-04：直接指挥与生效回执

用户从岗位详情发言，服务端识别询问与控制；不直接公开 Managed Session 的内部 sendMessage 权限。歧义控制先生成可审阅提案，普通已授权命令直接受控执行。

| 用户动作 | 后端处理 | 界面应显示 |
| --- | --- | --- |
| 询问进度 | 优先读取权威状态，需要判断时才发咨询 | 状态时间及回复来源 |
| 提高优先级 | CAS 修改排队属性 | 已生效或版本冲突 |
| 暂停任务 | 先停止新准入，再按 Harness 能力处置活动 Run | 请求已收到 / 等待停止 / 已暂停 |
| 取消任务 | 持久命令、实际取消确认、旧结果隔离 | 取消中 / 已取消 / 无法确认 |
| 换模型或负责人 | 影响分析、授权校验、旧执行处置、新 epoch | 旧执行状态和新负责人，不伪装原地切换 |
| 改范围或技术路线 | 新契约版，失效相关候选验收和审批 | 变更影响与生效版本 |

实际 runtime family 支持什么就开放什么；steer 和 interrupt + next-turn 的区别可用“运行中补充 / 停止后继续 / 下一轮处理”等用户语言表达。网络断开不能把乐观 UI 状态当成功；同 commandId 重连查询，避免重复执行。

### P3-05：任务知识与换人交接

扩展现有 context-projector、organization-context-projection、ResultPacket 与 checkpoint/handoff：注入任务契约、输入候选、关键决策来源、失败记录、未决问题、待答复消息、权限及剩余预算。

每份摘要有 source refs 和契约版；事实变动后标过期并重新生成。摘要不是授权，也不是数据库状态来源。控制可见范围及大小，必要时按引用取详情；不能用全团队聊天拼接替代任务上下文。

换模型时复用任务事实，重新选择 provider/model/effort 和工具能力，不移植不兼容的 provider session 内部状态。保留旧交接版本以解释后续决策。

### P3-06：Web 迭代

复用 `static/chat/organization-view.js` 与现有样式/事件入口，增加：

- 团队概览：岗位、当前任务、实际运行能力、运行/空闲/阻塞。
- 任务列表与详情：依赖、里程碑、版本、候选、证据、历史 Attempt。
- 决策区：审批内容与准确目标，命令状态和失败原因。
- 岗位入口：持久邮箱、咨询及授权控制；不跳过 managed input。

优先可读任务板和明确动作，不把复杂组织编辑动画作为前置。进度使用已验收任务数和真实阶段，不展示模型猜测百分比。

### P3-07：Android 接入

沿用 `android/feature/organization` 的 API、Repository、ViewModel、Reducer 和详情组件，统一 HTTP 响应包络、schemaVersion、asOf/event cursor。阶段 0 发现的读契约差异应先收敛。

增加 Work Item 列表/详情、岗位消息和控制 command receipt；所有写命令经现有安全传输和服务端授权。离线时显示缓存时间，不允许离线确认发布；重连拉取权威结果，不重复发送新 idempotencyKey。

兼容旧服务端缺少能力、旧客户端只支持 projection v1/v2 的情形。能力不足明确只读或不支持；Android UI 功能开启不等于后端已授权。Android 本地 proot 等并行开发能力不作为本阶段默认前提。

## 3. API 和投影原则

Work Graph 的状态仍从领域 Store 推导。Projection 是读模型，必须暴露稳定 ID、版本、cursor、asOf、活动 Operation 及可执行动作；可执行动作只是提示，执行时再次授权。

支持增量事件丢失后的全量重取、缓存失效和乱序事件处理。UI 不从有限 recentEvents 计算任务真状态；消息动画不能替代真实投递状态。敏感运行参数、密钥、签名 token 不出现在公开投影。

## 4. 既有检查与实际证据

按实际改动选择 `test-chat-organization-view.mjs`、`test-organization-projection-v2.mjs`、`test-autonomous-organization-s18.mjs`、S20/S22/S24、`test-session-manager-control-state.mjs`、`test-provider-contract.mjs` 和 Android 已有 OrganizationReducerTest、OrganizationLayoutEngineTest、CommunicationVisualSchedulerTest。

已有检查只能说明它们覆盖的状态/布局/协议。实际指挥、网络重连、真实 Harness 停止以及 Android 真机显示需绑定阶段 2 的真实任务；没有此证据就保留未验证标记。新增测试或录制基础设施仍需另行许可。

## 5. 退出条件

- 以 organizationId 可再次进入同一长期团队，换会话不丢失任务及历史。
- 管理、审查、咨询边各自明确，不扩大权限；运行中修订有影响记录。
- 用户可以从岗位界面发消息并查看回执；控制命令可区分请求与真正生效。
- Web/Android 对同一任务显示一致事实；断线与失败不显示虚假完成。
- 任务交接引用可信事实，换模型不会丢弃验收基线或历史失败。
- 现有普通聊天、组织读视图和旧客户端不因新编辑能力而失效。

## 6. 回退

分别关闭新控制入口和新展示，保留消息、操作与岗位历史。后端停止新准入后仍能查看和取消存量任务。不要通过恢复普通 Managed Session 输入绕过来维持旧 UI；旧端继续只读或获得明确不支持响应。
