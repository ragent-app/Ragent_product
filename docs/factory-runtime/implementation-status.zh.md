# Factory Runtime 实施状态

更新：2026-11-14。源码：`G:/AgentoC/Ragent_product`，`main`。原始核查 HEAD `3628b2ef5f5627fe2118bda40691150c8d1da74f`；方案文档提交 `18250b9ccdb50ec05bd30d44cf2ff684a623b00a`。工作树含其他未提交修改，以下为本次工作状态，不把代码存在等同于真实运行通过。

本次相关源码提交按先后为 `cc06da9b`（Work Graph）、`3e6c635e`（执行与交付基础）、`1cb89b82`（团队控制与客户端）、`dfa35fba`（撤权与消息回执）、`f88f1dc3`（备份、画像约束与 shadow 观察）、`baf143c3`（受限独立审查意见与容量等）、`5ab7df32`（组合检查与集成、团队关系和交接）、`932f8b0b`（既有检查的 Run 身份契约对齐）、`ea0d9445`（单候选检查终态证据）、`442f4d09`（托管节点换绑时的 Run 准入栅栏）、`0d147ca4`（只读协商、Steering 与 P5 对账退休源码）、`d4b9ad77`（Factory 对账观察）、`2c297025`（隔离 launcher 的 owner 密码启动兼容）、`48cdfdae`（GitHub 发布与构建证明适配、托管 Session 身份修复）、`2777ca26`（本地任务受限 handoff 接入）；与之并行的其他提交不代表 Factory 全阶段完成。

| 阶段 | 已实现（源码事实） | 缺实现 | 未验证 |
| --- | --- | --- | --- |
| 0 现状与前置 | 返工上下文持久化、托管 Session 绑定校验、Factory 候选先于回写、Android 组织投影包络修正 | 各平台真实只读/权限能力仍需按实际运行边界补齐 | 真实 Harness、服务重启和真实项目 |
| 1 Work Graph | 加法 schema、契约/候选/决策、CAS、依赖/状态/控制、分页、事件及服务端授权；保留 legacy/shadow/active 标记；ResumeWork 可解除暂停控制，失败项目按 RetryWork 规则处理；已提交按页 Run/Packet 对账源码 | 仅显式组织归属的旧任务有分页 shadow 快照；缺归属历史不自动猜测 | 按页对账尚未真实执行；新图业务行为及迁移兼容尚无新 oracle |
| 2 执行 | 服务端开关与组织白名单、受限服务主体、scheduler/adapter、预算预留/可证实时结算、共享 broker 任务栅栏、候选与派生验证工作区、定向取消及权限撤销处置 | 未知副作用的自动恢复/补偿不完整；缺可信用量时预算持续保留，不能宣称自动结算 | 真实进程、预算、取消、重启及恢复 |
| 3 团队指挥 | owner 读写/回执、Web/Android 基础任务控制、节点消息与回复、生命周期与节点换绑；类型关系版本/停用和有界任务交接快照；已提交本地 dispatch 受限 node/工作项上下文接入源码，截断时 freshness 为 unknown_truncated | 远端上下文未接入，全项目长期任务知识仍不完整；当前 Steering 为绑定 Run 的受控请求，其他 provider 明确 unsupported；交接的剩余预算等缺失事实保留 unknown | 新节点消息、活跃授权撤销、Android 真机、断线重连 |
| 4 工作流与交付 | 版本化公式、v2 受限独立审查意见、人工验收、注册检查、单候选及有序多候选组合的固定输入、派生验证、真实 Git commit 协议及不可变组合收据；包/授权/幂等发布操作；已提交源码支持显式 GitHub Release 与外部结果查询、签名构建证明校验、完整 draft 显式恢复 | PR 创建/更新/合并渠道（若采用 PR）及长期交付证据策略仍不完整；空/部分 draft 不自动补传，崩溃停在 sending/recovering 缺安全恢复入口；无已配置可信证明时发布受阻 | 独立审查、组合验证、真实项目集成、GitHub attestation/release 及恢复尚未贯通；未实际发布 |
| 5 灰度与验收 | 加法表、服务端准入开关/白名单、关闭新准入时观察既有任务、按组织分页 shadow 快照、可选 bounded 观察循环与持久水位、状态读取；数据库备份工具具备锁定、活动操作检查、完整性检查及清单源码；跨库 shadow 页面对账及 workspace 显式退休源码已提交 | 全量历史事实、Run 文件与外部副作用的一致检查点、部署监控/分平台能力矩阵及旧入口退出流程未完成 | 备份工具尚未实际运行；尚无真实灰度、部署、重启、恢复、跨平台和回退证据 |
本次未访问生产数据库、调用真实 Harness、重启服务、部署或发布，未创建测试。完成项需后续审阅及适用的现有可信检查支持。模板来自本仓库方案而非已证实的业务运行流程，不能将其称为已验证模板。

Windows G: 隔离环境既有检查：`tests/test-collaboration-store.mjs`、`tests/test-collaboration-orchestrator.mjs` 通过；collaboration-store 首轮因环境变量冲突失败，修正 G: 隔离环境后单次重跑通过。`tests/test-organization-provisioning.mjs` 通过 51 项。`tests/test-phase-gates.mjs` 曾在约 30 条断言后因 status 缺少与 manifest 相同的既有 requestId 而失败；仅为现有 helper 补齐该同值（未新增数据、断言或改变预期）后，单次通过 59 项，包括返工部分。`tests/test-run-publication.mjs` 单次通过 16/16。Windows 上另有两项既有检查各运行一次失败：`test-codex-app-server-adapter.mjs:39` 的默认 project trust 预期与当前实现不一致；`test-reviewer-readonly.mjs:145` 预期内建 bwrap 可用，而 Windows 未认证该能力。未修改断言，亦不证明新 provider 只读协商通过。这些结果不证明新 Factory、真实 Harness 或生产恢复。

团队控制既有检查：`tests/test-chat-organization-view.mjs`、`tests/test-organization-projection-v2.mjs`（29 项断言）与 `tests/test-session-control-capability.mjs`（旧 root 范围）通过；这些不覆盖新增节点消息能力或真实执行。Android 离线 `:app:compileDebugKotlin` 在修正既有 G: debug keystore 路径及参数后通过；此前两次在编译前因签名路径及参数引用失败。该结果不证明 APK、设备或重连能力。上述检查在原基线与并行未提交修改组成的工作树上执行，不代表已发布版本。

新增 FactoryWorkScreen 只读交付证据后，同一离线 Android Kotlin 编译再次通过（JDK 21 与既有 G: SDK、缓存和 keystore；165 项任务中 4 项执行、161 项已是最新），包含并行未提交源码；仅有既有弃用警告，不代表设备或真实运行通过。

`tests/test-autonomous-organization-s22.mjs` 退出码 1：第 50 行的替换流程因当前 managed session 不存在而被要求先对账；该既有 fixture 使用虚构的 root 等标识，未修改 fixture 或预期。不能据此断言只是 fixture 问题，新增换绑行为的兼容性检查未通过；该检查注入不存在的 session-old，provisioning 检查也注入 mock factory，均不能覆盖真实 createSession metadata 和 owner rebind。安全边界未改，本轮未重跑或改 fixture，真实调用链仍需核查。`tests/test-session-control-renewal.mjs` 退出码 0，覆盖既有续期、路由及客户端重试，不证明新增 worker 能力范围。

2026-11-14 使用既有 launcher 在 G: 独立目录启动当前共享源码工作树一次，仅进行无付费基础服务验收：健康与 CLI transport 为 ready，`/` 和 `/chat/bootstrap.js` 返回 200，未认证组织 API 返回 401；未创建组织或 Run，未调用 provider。90 秒 TTL 按约定结束，launcher 报退出码 124、独立实例已清理；观察到目录峰值约 289,225 字节。未采集冷启动就绪耗时，不推断性能或真实 Factory 业务通过。工作树当时含其他并行修改。后续目标、公式和暂停恢复的真实 API 序列尚未执行：原 launcher 种入旧静态 token，与当前密码登录不兼容；`2c297025` 已改为隔离密码启动，但新业务流程尚未验证；现有组织创建依赖 root leadership proposal，尚未找到无需模型 Run 的公开创建入口。未通过改库或伪造主体绕过。修复后准备的一次真实登录命令被自动工具拒绝（`rejected: blocked by policy`，未给更具体原因），CreateProcess 未执行，未创建新实例、文件或进程；未绕过重试。`2c297025` 仅有静态/语法证据，并非登录通过。

工作流预算按调用者明确提供的 `maxCost`、工作项数量与最大尝试次数计算每次成本预留；最终准入仍由组织 Governor 实际限额与授权决定，不假定预算充足。审查任务的候选输入范围与写入授权分别表达，复用共享 broker 的任务级策略。

工作流来源：`agentoc-reviewed-change` 是依据本次项目实际开发活动中的实现、独立审查、已有检查和集成步骤抽象的公式；本仓库 [public-boundary.yml](../../.github/workflows/public-boundary.yml) 提供已有检查步骤的具体来源，不能视为该 CI 文件被自动转换或执行过。v2 明确要求独立意见，v1 的既有合同不自动升级；所需的受限意见仍是审查者判断，不证明业务正确或检查通过。真实项目实例尚未贯通。

## 启动配置与能力边界

默认不准入新的 Factory 工作。要在经授权的服务器上启用，须由服务端配置 `AGENTOC_FACTORY_SCHEDULER_ENABLED=1`、`AGENTOC_FACTORY_ORGANIZATIONS` 逗号分隔组织白名单和 `AGENTOC_FACTORY_SCHEDULER_OWNER_ID` 授权来源；后台使用受限 scheduler 服务主体，不把请求体中的身份当作 owner。每个组织还须有正整数 `policy.factoryMaxConcurrent`、明确的运行次数/Token/成本预算，并启用现有 Governor。组织节点须具备当前有效的 run 授权，写任务还须具备覆盖其路径的 write 授权。关闭新准入后，配置了组织和授权来源的服务仍可观察并对账已有执行；关闭服务本身不会继续计算。

`accessMode: read` 表示候选输入只读任务，`accessMode: write` 的交付路径必须处于节点写入授权内；候选范围不自动扩充写权限。执行复用共享 broker，实际工作目录和受限输入由任务绑定；不声称共享进程提供操作系统级隔离。Windows Codex 只读路径使用同一共享 broker 的 provider 协商与报告，非独立服务；实际 provider 响应及强制效果尚未验证。候选暂限 1,000 个文件、32 MiB 范围，拒绝符号链接及缓存/构建目录；可通过拆小授权范围处理，不能静默截断。未知用量保留预算预留；只有可归属该 Run 的完整 provider 实际用量才能结算。上述配置和实现均未在真实项目或重启恢复中验证，本次没有在本机启用。

`AGENTOC_FACTORY_SHADOW_SYNC_ENABLED=1` 可在既有 observer 循环按组织白名单启用只读来源的分页 shadow 投影；默认关闭。水位与快照同事务写入，不启动 Run、不发消息、不把旧成功当验收。仅映射明确声明组织且同项目或项目缺失的 Collaboration；未关联组织及跨库 Run/Packet 的真实性仍需人工核对。完成一轮的时间不等于业务验收通过。

备份工具只覆盖三个 SQLite 数据库，使用数据库写锁检查已知活动项；不复制 Run 文件或项目产物，也不证明外部副作用已停止。只读连接在 WAL 模式下仍可能创建或更新源目录的共享内存文件；工具未实际运行，不能据此声称恢复已验证。

本次工作区的存储约束：工作产物、临时目录及可变缓存留在 `G:/AgentoC`；这不是对产品其他用户的盘符要求。不清理其他并行任务或用户数据。此前 G: 降至约 1.78 GiB，曾停止构建和 API 验收；随后容量恢复，最近核查可用 12,218,535,936 字节（约 11.38 GiB），变化原因未确定；没有因空间变化扩大清理范围。此前组织投影、S22 临时目录和空 factory-check-work 目录已按用户授权清理。既有 run-publication 检查明确保留的 `G:/AgentoC/temp/agentoc-run-publication-92Nk4b` 含 72 个文件、68,961 字节；保留不等于完成清理。

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
