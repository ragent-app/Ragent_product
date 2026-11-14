# Factory Runtime 实施状态

后续缺口与验收顺序见 [剩余工作与验收清单](remaining-work.zh.md)。

更新：2026-11-14。源码：`G:/AgentoC/Ragent_product`，`main`。原始核查 HEAD `3628b2ef5f5627fe2118bda40691150c8d1da74f`；方案文档提交 `18250b9ccdb50ec05bd30d44cf2ff684a623b00a`。工作树含其他未提交修改，以下为本次工作状态，不把代码存在等同于真实运行通过。

后续增量：`082be101` 增加发布直接进程完成回执与备份证据索引；`e6a39b38` 为远端委派固定不含收件箱的任务摘要；`a6ee4851` 支持 owner 显式逾期提醒。知识授权的合同栅栏和 dispatch 改动被并行提交 `e36fe334` 夹带，其余闭包在 `0c9719da`：owner 可把已有项目事实固定到单个任务，来源变化在发送前拒绝；该提交时远端带知识引用的任务拒绝，后续改动见下文，跨库检查与实际发送不原子。上述增量不等于真实业务验收。

`233094db` 增加受限 Run 的结构化阻塞提案和 owner 显式处置源码；真实提案、权限撤销及重启恢复尚未验证。

后续源码：`0b5da17a` 为 owner 增加单工作项、单专家的只读咨询及列表、对账、未发送请求恢复；意见关联实际 Run 与 ResultPacket，未核实的用量预留继续保留。`43b66938` 统一 claim、发送和运行撤权的 Grant 校验，并按冻结节点能力物化授权记录；不能从只读权限推导 run。`af3038e0` 增加受限单节点 reviewer 的 owner 授权修订，以及仅在可信发送前事实成立时记录未启动和释放预算的路径。`fde9e3be` 提供有界、尽力记录的 Factory API 403 观测，不是完整权限拒绝历史；`3ba8d118` 修正 Android 离线缓存的 Kotlin 函数体，离线缓存仍未编译。`43c9b9cd` 和 `64977acb` 为备份增加可选有界 Run 文件与已登记产物摘要观察，inventory 的缺失数据库标为未知；不复制 Run/产物，也不提供跨库与文件系统的原子检查点。这些增量尚无对应真实业务运行或恢复证据。

`e582cd88` 持久化显式 Agent capabilities，`c524291b` 让 Web 如实显示未启动预留的对账结果。`af3038e0` 提交前交叉审查发现并修正未启动回执 INSERT 的列数与占位符一致性；这是静态审查，不是该恢复路径的运行验证。

后续 `663ba138` 增加对正式三库备份的校验及新目录恢复工具，`62d0690f` 将 owner 初始化非终态纳入备份栅栏并兼容旧 manifest；`3d5caf89` 为显式发布恢复增加该次直接 gh 命令返回的不可变回执及有界关联索引，不证明先前 producer 或外部效果静止。`48c610c5` 和 `6a43a1d8` 分别修复远端 child 与 workflow 的 Goal 插入列数；三处 Goal 写入已静态核对。新增路径尚未完成真实恢复、远端派发、workflow 或发布验收。

跨组织的容量不是天然隔离：实例及项目并发上限会把 unknown binding 计入容量；若配置上限为 1，另一组织也可能被阻断。不得通过跳过或清除 unknown 来绕开上限。远端知识引用此前拒绝；`5a1ef95c` 增加双向 Accounts 范围、固定事实和发送前在线回查。目标是否具备反向正式授权与真实跨实例执行尚未验证；源公钥和静态签名本身不能证明之后未撤销。

后续 `db3a0130` 增加 owner 明确发起的初始单 reviewer 组织入口，`12f1491b` 增加首个绑定执行的 owner 只读报告授权；两者均不是通用多岗位组织创建。`2908eac6` 增加 Linux 共享 Codex provider 只读协商路径，需显式启用；预算预留与 provider 实际计费是不同事实，不是保证费用的硬上限。Linux 的 `0bab816e` 基础加 `12f1491b`/`6a43a1d8`/`2908eac6` 受限 overlay 已启用该只读开关；首项当时停在 claimed/intent，因 `COLLABORATION_CHILD_LIMIT` 预检失败而未创建 Run，随后 pause_requested，未进入 provider thread/turn。后续修复与真实报告结果另按实际证据记录，不能把该次尝试称为只读执行通过。

`27645247` 修正 Collaboration 单计划 child 数边界，完整计划仍受 maxChildren 限制。`257fc76d` 提供 owner 对尚未确认的暂停请求的撤回：只适用于未绑定且无 Collaboration/远端操作的当前 intent，保留原 binding、epoch、dispatchKey 与预算；不代表任务曾停止，也不自动恢复旧 unknown。本次已通过正式操作成功撤回未确认暂停，保持原 epoch、dispatchKey 与预算；真实并发竞争仍未验证。

后续真实备份源码审查 Run 已创建、启动并 finalized 为 failed：Run manifest 显示 Codex app-server/read，实际 launch mode 为 runner-lifecycle；实际 lifecycle 进程缺少 `AGENTOC_CODEX_PROVIDER_READONLY`，该进程环境经 allowlist 传递给 sidecar，导致执行侧能力判断不匹配。实际 usage 尚无可信证据，不能记为零消费；后续 lifecycle 配置和另一个已授权任务结果须另行记录，不能由首项失败推断通过。

另一个已授权的 Android 源码审查 Run 已 completed：共享 `codex-app-server-json` thread 报告 cwd `/opt/agentoc/app`、readOnly、network=false、MCP 0 和可调用 app 0，并出现语义事件。这是 provider thread 报告，不证明通用 OS 隔离。最新 provider 累计观察为 131756 tokens（input 130569、cache 109568、output 1187），已超每项 50000 和本轮 100000 的预留；请求取消时已 completed，不能记作取消成功。已停止新 Run；最终可结算 usage、费用和人工验收仍待核实，预算预留不是硬费用或实时 token 上限。

最终 Linux 部署基于 `0bab816e` 加 manifest 所列逐文件 overlay，末次加入 `a29403d8` 两个 producer 文件及 `adac55c9` adapter；三文件核对无不匹配，manifest SHA-256 为 `110e430c5f7b216da8e4a24b6de4e9847af1903bad63dd61e41eae87f6d87460`，回退包为 `/home/pinggu/factory-deploy-a6ee4851/overlay-a29403d8-before.tar`。`ragent.service` active，最后一次服务重启耗时 0.371 秒，正式 summary 的 active sessions/runs/approvals 为 0/0/0；未启动新 Run，此部署不证明新 producer 的业务链路通过。

现场对账后原实例与项目并发上限均读回为 1，重启前正式 summary 的 active session、Run、approval 均为 0；只重启了 ragent.service。旧组织的 1 Run / 20000 tokens / 1 美元预留和新组织的 2 Run / 100000 tokens / 5 美元预留均未结算；两次费用 unknown。旧组织的 unknown binding 仍计入跨组织实例及项目容量；没有新增模型 Run。

该审查的原始报告指出 Android 离线撤权与显示问题，后续 `430729f7` 已提交修复源码，尚未编译或设备验证。canonical ResultPacket 因 producer 未关联最终正文而摘要为空，旧 packet 保持不可变，正式报告候选与人工验收未通过。owner 随后正式请求取消并对账完成事实：binding 为 finished，工作项为 blocked/completed_pending_review、control none、candidateDigest null；这不是 cancelled 或 passed。实际费用仍未证实。`5a1ef95c` 的预算 guard 仅接收正整数 token 预留的 Codex app-server；cost-only 或其他 Harness 在 claim 前拒绝。预算固定到 Run manifest，匹配的可信 usage 达阈值发出定向取消；重启不归零已用量，未知仍保留，在途用量仍可能超额。远端旧记录缺 token 的读取、候选与取消保留，新 dispatch 拒绝；尚待真实运行验证。`adac55c9` 增加 provider 嵌套 total/last 用量解析；thread 累计值不能当作单 Run 结算，修复后尚无新 Run 验证。`a29403d8` 修正后续报告 producer，从匹配已 finalized Run 的严格历史中读取有界最终正文并记录来源；旧 packet 保持不变，新路径尚无新 Run 验证。

`1927a085` 备份索引源码补充单项/组合 Git operation、远端 source/target journal 与 evidence 的有界本地关联和观察时间；新记录仅在固定 source identity、非活动 binding 与已有签名终态核验通过时可视作本地终态。旧记录缺身份、截断或证据不足保持未知并阻断；观察不查询外部服务，也不证明跨库原子或外部全局静止。Linux 实例部署 `1927a085` 四文件、语法通过，服务 active 且未重启；以其正式 inventory 观察，三库均存在、workflow 已初始化；活动 execution binding 1、scheduler leases 2，其余列示活动项为 0；两条关联 Attempt 的 Run status/manifest/result 均 publication_matched，Attempt/Packet 数据库引用已检查；remote 表未初始化，remote links 为 unknown_incomplete_index。此结果仅为非原子的观察，不生成 backup 或证明外部效果静止；紧凑摘要保存在 `G:/AgentoC/factory-restore-overlay-1927a085/inventory-summary.json`。本轮没有新增模型 Run；Windows 本机可用内存约 490 MiB、G: 可用约 23 GiB，Android 后续离线修复未再编译或真机验证。

用户已授权本机及指定 `pinggu` 开发实例验收。执行侧报告 Linux 部署的 `a6ee4851` 服务和 owner CLI 可用；初查没有组织与 project-workflow 数据库，后续真实组织规划已完成。初次正式 owner API 查询时 Factory status、shadow 和 work-items 均返回 HTTP 200；后两者为空，status 显示控制和自动准入关闭、executionReadiness 未验证。空列表不证明历史迁移或任务闭环。最新工作树上的知识和后续 readiness 改动不在该部署版本中。分平台条件与现场证据分列于 [能力矩阵](capability-matrix.zh.md)。

现场后续 shadow 同步返回 observed=0、changed=0；这是空历史读取的证据。真实图任务尝试发现规划节点的授权账本缺少 run，已有 claim 被阻断并留下 unknown binding；不能把该状态当作 Run 已启动或已停止。后续源码收紧准入并修复新节点授权物化，既有节点还需正式 owner 修订授权和对账。

Linux 以正式 `64977acb` inventory 观察：collaborations 与 coordination 数据库可用，workflow 数据库 `source_unavailable`；executionBindings=1、runningAttempts=0、dispatchCommands=0，Attempt/Packet 关联为 `unknown_incomplete_index`，产物及外部效果未检查。指定实例 Run 根目录后，数据库引用范围内的 Run 观察为 `items=[]`，不等于扫描全部历史 Run。该调用 `copiesCreated=false`、`observational_only`，结果仅保留工具 stdout，未执行备份或 quick_check；零 Attempt/dispatch 不证明历史 unknown producer 已停止。此前将脚本单独置于临时目录的一次启动因缺相对导入而失败，未打开数据库，后改用正常目录执行。

Linux 随后在 `a6ee4851` 基础及既有 `bbd95785`/`ecaad841`/`0f8bbb32`（仅 Goal INSERT）overlay 上追加 `af3038e0` 精确 12 个模块和 router 授权 hunk，共 13 个部署文件摘要匹配、服务 active，原文件备份可回退；不是整个当前工作树部署。正式 GET 返回 org version 3、revision 1、generation 1、能力 `[read]`、activeOrUnknownBindings=1、quiescence 未验证。owner 申请 `[read,run,review]` 被明确拒绝，原因是存在活动或未知 Factory 执行；重读状态不变。工作项仍为 blocked/authorization_revoked，binding 为 unknown 且无 Collaboration/Attempt/Run；预算 API 返回 Not Found，改用获授权的组织范围 SQLite 只读查询，revision 1 已计 runs/tokens/cost 为 0/0/0，预留为 1/20000/1，未释放。该次观察没有新 Run、未修改 Agent 或预算；这仅验证拒绝保护，不能视为授权修订成功或任务闭环。后续两次真实任务及其结果见上文。

Windows 现有本机服务 `localhost:18673` 的 `/api/build-info` 返回 HTTP 200，报告 service `v0.0.76`、UI `mwfyxt4y`；进程来自 `G:/AgentoCapp/payload/chat-server.mjs`。Chrome 新建任务标签访问时，控制工具报 `Cannot read properties of undefined (reading timeoutMs)`，未取得页面状态，不能据此认定产品页面失败或通过。

Linux 真实规划的三次尝试：① `a6ee4851` 的 `run_5bec3b56ffc0b6d77ba0aa0f` 请求 untrusted-read-only，实际持久模式扩大为 on-request-danger-full-access，发现后定向取消并 finalized；可见 spool 仅有 rg/sed 读取命令。② 加只读修复 `bbd95785` 的 `run_79302a372bb5347b34aeadf5` 持久 untrusted-read-only，但 provider 回报 on-request/readOnly/no-network，因 `CODEX_APPROVAL_POLICY_UNVERIFIED` 在 prompt 前失败并 finalized。③ 同源码的 `run_4873b45058010066b2942c40` 显式 on-request-read-only，provider 确认 on-request/readOnly/network false/user reviewer/cwd，completed 并 finalized；创建真实组织 `org_158df796b2b874cefbe45bea` revision 1 和只读 reviewer，当时尚无 Factory Attempt。此结果不证明 untrusted 审批或 Factory 闭环；Run 实际费用尚未知。

本次相关源码提交按先后为 `cc06da9b`（Work Graph）、`3e6c635e`（执行与交付基础）、`1cb89b82`（团队控制与客户端）、`dfa35fba`（撤权与消息回执）、`f88f1dc3`（备份、画像约束与 shadow 观察）、`baf143c3`（受限独立审查意见与容量等）、`5ab7df32`（组合检查与集成、团队关系和交接）、`932f8b0b`（既有检查的 Run 身份契约对齐）、`ea0d9445`（单候选检查终态证据）、`442f4d09`（托管节点换绑时的 Run 准入栅栏）、`0d147ca4`（只读协商、Steering 与 P5 对账退休源码）、`d4b9ad77`（Factory 对账观察）、`2c297025`（隔离 launcher 的 owner 密码启动兼容）、`48cdfdae`（GitHub 发布与构建证明适配、托管 Session 身份修复）、`2777ca26`（本地任务受限 handoff 接入）；与之并行的其他提交不代表 Factory 全阶段完成。

| 阶段 | 已实现（源码事实） | 缺实现 | 未验证 |
| --- | --- | --- | --- |
| 0 现状与前置 | 返工上下文持久化、托管 Session 绑定校验、Factory 候选先于回写、Android 组织投影包络修正 | 各平台真实只读/权限能力仍需按实际运行边界补齐 | 真实 Harness、服务重启和真实项目 |
| 1 Work Graph | 加法 schema、契约/候选/决策、CAS、依赖/状态/控制、分页、事件及服务端授权；保留 legacy/shadow/active 标记；ResumeWork 可解除暂停控制，失败项目按 RetryWork 规则处理；已提交按页 Run/Packet 对账源码 | 仅显式组织归属的旧任务有分页 shadow 快照；缺归属历史不自动猜测 | 已执行空 shadow 同步；代表性历史按页对账、新图业务及迁移兼容尚无现场证据 |
| 2 执行 | 服务端开关与组织白名单、受限服务主体、scheduler/adapter、预算预留/可证实时结算、共享 broker 任务栅栏、候选与派生验证工作区、定向取消及权限撤销处置 | 未知副作用的自动恢复/补偿不完整；缺可信用量时预算持续保留，不能宣称自动结算 | 真实进程、预算、取消、重启及恢复 |
| 3 团队指挥 | owner 读写/回执、Web/Android 基础任务控制、节点消息与回复、生命周期与节点换绑；有界本地及签名远端任务交接、任务级显式知识引用、受控咨询源码 | 远端不传收件箱；知识引用在线核验源码已提交但真实双实例未验，全项目长期任务知识仍不完整；当前 Steering 为绑定 Run 的受控请求，其他 provider 明确 unsupported；交接的剩余预算等缺失事实保留 unknown | 咨询 Run/意见与跨库恢复、远端交接与知识引用、新节点消息、活跃授权撤销、Android 真机、断线重连 |
| 4 工作流与交付 | 版本化公式、v2 受限独立审查意见、人工验收、注册检查、单候选及有序多候选组合的固定输入、派生验证、真实 Git commit 协议及不可变组合收据；包/授权/幂等发布操作；已提交源码支持显式 GitHub Release 与外部结果查询、签名构建证明校验、完整 draft 显式恢复 | PR 创建/更新/合并渠道（若采用 PR）及长期交付证据策略仍不完整；空/部分 draft 不自动补传，崩溃停在 sending/recovering 缺安全恢复入口；无已配置可信证明时发布受阻 | 独立审查、组合验证、真实项目集成、GitHub attestation/release 及恢复尚未贯通；未实际发布 |
| 5 灰度与验收 | 加法表、准入开关/白名单、shadow 观察与对账、数据库备份源码、workspace 显式退休；按组织状态观测见 `cf722af1`，分平台条件见 [能力矩阵](capability-matrix.zh.md) | 全量历史事实、Run 文件与外部副作用的一致检查点及旧入口退出流程未完成；权限拒绝与 provider 停止结果缺完整收据 | Linux `a6ee4851` 已部署且服务可用；备份、真实灰度、任务重启恢复、跨平台和回退尚无完整证据 |
先前 Windows 隔离批次未访问生产数据库、调用真实 Harness、重启服务、部署或发布，未创建测试；后续 Linux 开发实例的部署事实以上方记录为准。完成项需后续审阅及适用的现有可信检查支持。模板来自本仓库方案而非已证实的业务运行流程，不能将其称为已验证模板。

Windows G: 隔离环境既有检查：`tests/test-collaboration-store.mjs`、`tests/test-collaboration-orchestrator.mjs` 通过；collaboration-store 首轮因环境变量冲突失败，修正 G: 隔离环境后单次重跑通过。`tests/test-organization-provisioning.mjs` 通过 51 项。`tests/test-phase-gates.mjs` 曾在约 30 条断言后因 status 缺少与 manifest 相同的既有 requestId 而失败；仅为现有 helper 补齐该同值（未新增数据、断言或改变预期）后，单次通过 59 项，包括返工部分。`tests/test-run-publication.mjs` 单次通过 16/16。Windows 上另有两项既有检查各运行一次失败：`test-codex-app-server-adapter.mjs:39` 的默认 project trust 预期与当前实现不一致；`test-reviewer-readonly.mjs:145` 预期内建 bwrap 可用，而 Windows 未认证该能力。未修改断言，亦不证明新 provider 只读协商通过。这些结果不证明新 Factory、真实 Harness 或生产恢复。

静态兼容判断：`9a232959` 有意把 Codex profile gate 改为 on-request，仅明确 untrusted 模式配置 project trust，并同步更新了部分但未更新全部断言；[adapter 旧断言](../../tests/test-codex-app-server-adapter.mjs) 与 [provider-contract 旧断言](../../tests/test-provider-contract.mjs) 因此仍期待旧行为，[旧 gate 方案](../approval-gate-adjustment-plan.md) 也未同步。该变更的源码明确 provider 不保证每条命令产生审批回调；真实风险体验仍需 provider 证据，本轮只读修复不改变无只读请求的默认策略。[reviewer 检查](../../tests/test-reviewer-readonly.mjs) 使用当前平台却期望 Linux bwrap 能力，Windows 失败不能证明 Linux 路径结果。[S22](../../tests/test-autonomous-organization-s22.mjs) 以不存在的 `session-old` 作为当前节点会话，而[换绑实现](../../chat/organization-replan.mjs)要求可核实会话及 Run 历史；fixture 不能证明真实换绑正确。未修改这些断言或新增替代测试。

团队控制既有检查：`tests/test-chat-organization-view.mjs`、`tests/test-organization-projection-v2.mjs`（29 项断言）与 `tests/test-session-control-capability.mjs`（旧 root 范围）通过；这些不覆盖新增节点消息能力或真实执行。Android 离线 `:app:compileDebugKotlin` 在修正既有 G: debug keystore 路径及参数后通过；此前两次在编译前因签名路径及参数引用失败。该结果不证明 APK、设备或重连能力。上述检查在原基线与并行未提交修改组成的工作树上执行，不代表已发布版本。

新增 FactoryWorkScreen 只读交付证据后，同一离线 Android Kotlin 编译再次通过（JDK 21 与既有 G: SDK、缓存和 keystore；165 项任务中 4 项执行、161 项已是最新），包含并行未提交源码；仅有既有弃用警告，不代表设备或真实运行通过。

后续 `a6ee4851` 消息升级源码的 Android 离线 `:app:compileDebugKotlin` 通过（165 项任务：12 项执行、153 项已是最新）；此前使用另一缓存的首次尝试因离线 AGP 9.1.1 缺失在编译前失败。之后 `cfc20b5d` 新增的离线缓存五文件不在该编译范围内，尚无编译或设备证据。

`tests/test-autonomous-organization-s22.mjs` 退出码 1：第 50 行的替换流程因当前 managed session 不存在而被要求先对账；该既有 fixture 使用虚构的 root 等标识，未修改 fixture 或预期。不能据此断言只是 fixture 问题，新增换绑行为的兼容性检查未通过；该检查注入不存在的 session-old，provisioning 检查也注入 mock factory，均不能覆盖真实 createSession metadata 和 owner rebind。安全边界未改，本轮未重跑或改 fixture，真实调用链仍需核查。`tests/test-session-control-renewal.mjs` 退出码 0，覆盖既有续期、路由及客户端重试，不证明新增 worker 能力范围。

2026-11-14 使用既有 launcher 在 G: 独立目录启动当前共享源码工作树一次，仅进行无付费基础服务验收：健康与 CLI transport 为 ready，`/` 和 `/chat/bootstrap.js` 返回 200，未认证组织 API 返回 401；未创建组织或 Run，未调用 provider。90 秒 TTL 按约定结束，launcher 报退出码 124、独立实例已清理；观察到目录峰值约 289,225 字节。未采集冷启动就绪耗时，不推断性能或真实 Factory 业务通过。工作树当时含其他并行修改。后续目标、公式和暂停恢复的真实 API 序列尚未执行：原 launcher 种入旧静态 token，与当前密码登录不兼容；`2c297025` 已改为隔离密码启动，但新业务流程尚未验证；现有组织创建依赖 root leadership proposal，尚未找到无需模型 Run 的公开创建入口。未通过改库或伪造主体绕过。修复后准备的一次真实登录命令被自动工具拒绝（`rejected: blocked by policy`，未给更具体原因），CreateProcess 未执行，未创建新实例、文件或进程；未绕过重试。`2c297025` 仅有静态/语法证据，并非登录通过。

工作流预算按调用者明确提供的 `maxCost`、工作项数量与最大尝试次数计算每次成本预留；最终准入仍由组织 Governor 实际限额与授权决定，不假定预算充足。审查任务的候选输入范围与写入授权分别表达，复用共享 broker 的任务级策略。

工作流来源：`agentoc-reviewed-change` 是依据本次项目实际开发活动中的实现、独立审查、已有检查和集成步骤抽象的公式；本仓库 [public-boundary.yml](../../.github/workflows/public-boundary.yml) 提供已有检查步骤的具体来源，不能视为该 CI 文件被自动转换或执行过。v2 明确要求独立意见，v1 的既有合同不自动升级；所需的受限意见仍是审查者判断，不证明业务正确或检查通过。真实项目实例尚未贯通。

## 启动配置与能力边界

默认不准入新的 Factory 工作。要在经授权的服务器上启用，须由服务端配置 `AGENTOC_FACTORY_SCHEDULER_ENABLED=1`、`AGENTOC_FACTORY_ORGANIZATIONS` 逗号分隔组织白名单和 `AGENTOC_FACTORY_SCHEDULER_OWNER_ID` 授权来源；后台使用受限 scheduler 服务主体，不把请求体中的身份当作 owner。每个组织还须有正整数 `policy.factoryMaxConcurrent`、明确的运行次数/Token/成本预算，并启用现有 Governor。组织节点须具备当前有效的 run 授权，写任务还须具备覆盖其路径的 write 授权。关闭新准入后，配置了组织和授权来源的服务仍可观察并对账已有执行；关闭服务本身不会继续计算。

`accessMode: read` 表示候选输入只读任务，`accessMode: write` 的交付路径必须处于节点写入授权内；候选范围不自动扩充写权限。执行复用共享 broker，实际工作目录和受限输入由任务绑定；不声称共享进程提供操作系统级隔离。Windows Codex 只读路径使用同一共享 broker 的 provider 协商与报告，非独立服务；实际 provider 响应及强制效果尚未验证。候选暂限 1,000 个文件、32 MiB 范围，拒绝符号链接及缓存/构建目录；可通过拆小授权范围处理，不能静默截断。未知用量保留预算预留；只有可归属该 Run 的完整 provider 实际用量才能结算。上述配置不代表所有平台能力均已验证；Linux 已取得上述受限真实运行事实，真实重启恢复及本机执行仍未验证。

`AGENTOC_FACTORY_SHADOW_SYNC_ENABLED=1` 可在既有 observer 循环按组织白名单启用只读来源的分页 shadow 投影；默认关闭。水位与快照同事务写入，不启动 Run、不发消息、不把旧成功当验收。仅映射明确声明组织且同项目或项目缺失的 Collaboration；未关联组织及跨库 Run/Packet 的真实性仍需人工核对。完成一轮的时间不等于业务验收通过。

备份工具只复制三个 SQLite 数据库，使用数据库写锁检查已知活动项；inventory 允许数据库缺失并明确标未知，实际 backup 仍要求三个库存在。可选 Run 根目录时最多观察 100 个关联 Run，每文件读取上限 2 MiB，并记录文件摘要、publication 身份及缺失或截断；可选产物根目录仅观察已登记包，最多 50 件、总读取 32 MiB，额外限制于显式根目录，不替代当前发布授权。该观察不复制 Run 文件或项目产物，也不证明外部副作用已停止；数据库锁不冻结文件，跨时刻变化和跨库一致性不能视作原子。只读连接在 WAL 模式下仍可能创建或更新源目录的共享内存文件；新版已执行上述 inventory，产物观察未运行，backup/restore 尚未验证。

本次工作区的存储约束：工作产物、临时目录及可变缓存留在 `G:/AgentoC`；这不是对产品其他用户的盘符要求。不清理其他并行任务或用户数据。此前 G: 降至约 1.78 GiB，曾停止构建和 API 验收，随后一度恢复至约 11.38 GiB；最近通报 G: 约 6.15 GiB、可用内存约 608 MiB，变化原因未确定，没有因此扩大清理范围。此前组织投影、S22 临时目录和空 factory-check-work 目录已按用户授权清理。既有 run-publication 检查明确保留的 `G:/AgentoC/temp/agentoc-run-publication-92Nk4b` 含 72 个文件、68,961 字节；保留不等于完成清理。

2026-11-14 的 P5 源码新增按组织分页对照真实 Run 与 ResultPacket 的页面回执，记录缺失、不一致及观察时间，跨库不保证原子；readiness 只展示已核页面，不推导整体就绪。显式 workspace 退休实现预览、引用与终态检查、持久冻结及恢复，同权限外部进程替换目录不受 OS 原子防护；涉及 privileged 批准历史时保守阻断，严格 history 读取可能触发现有 orphan 恢复。两项已静态交叉审查和语法检查，尚未在真实数据执行对账或删除。

原阶段 5 完成标准没有缩减：真实重启后的事实连续性、多 Harness 在同一工作图交付、多客户端实际操作、经授权发布与回退均缺现场证据。阶段 4 可使用现有直接 Git commit 路径；选择 PR 时，PR 的创建、更新、合并及未知结果查询仍是缺失功能。已提交源码新增显式 opt-in 的 GitHub Release provider 及查询；仅支持已有有效 GitHub Actions 签名构建证明的项目，其他渠道与缺证明项目仍不可发布。GitHub 请求、身份、发布、结果与中断恢复均未在真实服务验证。

| 本轮协作 | 可核实结果与边界 |
| --- | --- |
| 执行 | 定点审查并指出发布回执与实时状态、目标绑定、崩溃恢复语义及任务输入 scope 问题；另修 provider 证据时序和 thread 身份。真实 provider 未运行。 |
| 团队控制 | 修复 launcher 身份契约与真实 managed Session 绑定，增加节点换绑准入栅栏及本地任务 handoff 接入；并发和崩溃恢复尚无真实环境证据。 |
| 工作图 | 实现显式 GitHub provider 与可信构建证明校验，复审 handoff 的截断及 stale 重试问题；曾提出 generation 疑点，随后全链路确认 claim 固定节点代数并撤回该疑点；P5 分页对账与退休源码经静态反审。均未执行真实 provider 或业务数据。 |

上述只记录工作及其证据，不推算执行速度、成功率或生产表现。

GitHub 发布源码仅在 `AGENTOC_FACTORY_GITHUB_RELEASE_ENABLED=1`、组织策略明确 `factoryGithubRelease.repository`、`signerWorkflow`、`signerDigest` 且 owner 授权 scope 为 `github_release` 时可用。授权固定仓库、tag、工作流、资产摘要和已集成 commit；旧授权缺固定身份须重授权。通过 GitHub CLI 验证签名 SLSA 证明的来源 commit 与本地资产摘要，并要求远端已有相同 commit 的 tag；不创建或推送 tag。先创建 draft，验证唯一资产摘要后才发布；未知结果只查询，只有已捕获错误并进入 unknown 的完整核验 draft 可由 owner 显式恢复 finalize，空或部分上传不自动补传。进程崩溃停在 sending/recovering 时缺少发布子进程已停止的可靠事实，目前不能安全转为可恢复状态；不以 TTL 或共享 broker 状态推断。历史发布回执与实时查询分开；外部并发变更无法跨 GitHub 调用原子排除。真实 GitHub 认证、证明、发布及恢复未调用、未验证；超过 1,000 条的 release 列表保守拒绝。正式参数和返回事实分别参见 [GitHub CLI 证明验证](https://cli.github.com/manual/gh_attestation_verify)、[GitHub Releases API](https://docs.github.com/en/rest/releases/releases) 与 [Release assets API](https://docs.github.com/en/rest/releases/assets)。

本地 handoff 的输入冻结前，只有同一事务确认尚无 Collaboration 或派发身份时才可追加不可变新快照；已冻结输入不改写。发送前来源核验与真实 outbox 发送跨数据库及进程，不构成原子操作；真实 broker、并发和重启证据尚缺。
