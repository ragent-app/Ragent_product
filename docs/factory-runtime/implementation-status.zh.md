# Factory Runtime 实施状态

更新：2026-11-14。源码：`G:/AgentoC/Ragent_product`，`main`。原始核查 HEAD `3628b2ef5f5627fe2118bda40691150c8d1da74f`；方案文档提交 `18250b9ccdb50ec05bd30d44cf2ff684a623b00a`。工作树含其他未提交修改，以下为本次工作状态，不把代码存在等同于真实运行通过。

本次相关源码提交按先后为 `cc06da9b`（Work Graph）、`3e6c635e`（执行与交付基础）、`1cb89b82`（团队控制与客户端）、`dfa35fba`（撤权与消息回执）、`f88f1dc3`（备份、画像约束与 shadow 观察）、`baf143c3`（受限独立审查意见与容量等）、`5ab7df32`（组合检查与集成、团队关系和交接）；与之并行的其他提交不代表 Factory 全阶段完成。

| 阶段 | 已实现（源码事实） | 缺实现 | 未验证 |
| --- | --- | --- | --- |
| 0 现状与前置 | 返工上下文持久化、托管 Session 绑定校验、Factory 候选先于回写、Android 组织投影包络修正 | 各平台真实只读/权限能力仍需按实际运行边界补齐 | 真实 Harness、服务重启和真实项目 |
| 1 Work Graph | 加法 schema、契约/候选/决策、CAS、依赖/状态/控制、分页、事件及服务端授权；保留 legacy/shadow/active 标记 | 仅显式组织归属的旧任务有分页 shadow 快照；缺归属历史不自动猜测，跨库 Run/Packet 真实性未对账；暂停后恢复需显式 RetryWork | 新图实际业务行为及迁移兼容尚无新 oracle |
| 2 执行 | 服务端开关与组织白名单、受限服务主体、scheduler/adapter、预算预留/可证实时结算、共享 broker 任务栅栏、候选与派生验证工作区、定向取消及权限撤销处置 | 未知副作用的自动恢复/补偿不完整；缺可信用量时预算持续保留，不能宣称自动结算 | 真实进程、预算、取消、重启及恢复 |
| 3 团队指挥 | owner 读写/回执、Web/Android 基础任务控制、节点消息与回复、生命周期与节点换绑；类型关系版本/停用和有界任务交接快照 | 长期任务知识、完整直接指挥/Steering 仍不完整；交接的剩余预算等缺失事实保留 unknown | 新节点消息、活跃授权撤销、Android 真机、断线重连 |
| 4 工作流与交付 | 版本化公式、v2 受限独立审查意见、人工验收、注册检查、单候选及有序多候选组合的固定输入、派生验证、真实 Git commit 协议及不可变组合收据；包/授权/幂等发布操作与查询协议 | 可选 PR 渠道、长期交付证据策略及实际发布 provider 未完成；无 provider 时发布为 unsupported；中断写入未知结果需显式对账 | 独立审查、组合验证、真实项目集成及恢复尚未贯通；未实际发布；构建来源仍标记 unverified |
| 5 灰度与验收 | 加法表、服务端准入开关/白名单、关闭新准入时观察既有任务、按组织分页 shadow 快照、可选 bounded 观察循环与持久水位、状态读取；数据库备份工具具备锁定、活动操作检查、完整性检查及清单源码 | 跨库 shadow 完整对账、Run 文件与外部副作用的一致检查点、部署监控/分平台能力矩阵及旧入口退出流程未完成 | 备份工具尚未实际运行；尚无真实灰度、部署、重启、恢复、跨平台和回退证据 |
本次未访问生产数据库、调用真实 Harness、重启服务、部署或发布，未创建测试。完成项需后续审阅及适用的现有可信检查支持。模板来自本仓库方案而非已证实的业务运行流程，不能将其称为已验证模板。

Windows G: 隔离环境既有检查：`tests/test-collaboration-store.mjs`、`tests/test-collaboration-orchestrator.mjs` 通过；`tests/test-phase-gates.mjs` 在约 30 条前置断言后于共享 `run-publication-contract.mjs:21` 返回 INVALID_ARGUMENT，原因尚未确定，返工部分未到达。这些结果不证明新 Factory、真实 Harness 或生产恢复。

团队控制既有检查：`tests/test-chat-organization-view.mjs`、`tests/test-organization-projection-v2.mjs`（29 项断言）与 `tests/test-session-control-capability.mjs`（旧 root 范围）通过；这些不覆盖新增节点消息能力或真实执行。Android 离线 `:app:compileDebugKotlin` 在修正既有 G: debug keystore 路径及参数后通过；此前两次在编译前因签名路径及参数引用失败。该结果不证明 APK、设备或重连能力。上述检查在原基线与并行未提交修改组成的工作树上执行，不代表已发布版本。

新增 FactoryWorkScreen 只读交付证据后，同一离线 Android Kotlin 编译再次通过（JDK 21 与既有 G: SDK、缓存和 keystore；165 项任务中 4 项执行、161 项已是最新），包含并行未提交源码；仅有既有弃用警告，不代表设备或真实运行通过。

`tests/test-autonomous-organization-s22.mjs` 退出码 1：第 50 行的替换流程因当前 managed session 不存在而被要求先对账；该既有 fixture 使用虚构的 root 等标识，未修改 fixture 或预期。不能据此断言只是 fixture 问题，新增换绑行为的兼容性检查未通过，真实调用链仍需核查。`tests/test-session-control-renewal.mjs` 退出码 0，覆盖既有续期、路由及客户端重试，不证明新增 worker 能力范围。

工作流预算按调用者明确提供的 `maxCost`、工作项数量与最大尝试次数计算每次成本预留；最终准入仍由组织 Governor 实际限额与授权决定，不假定预算充足。审查任务的候选输入范围与写入授权分别表达，复用共享 broker 的任务级策略。

工作流来源：`agentoc-reviewed-change` 是依据本次项目实际开发活动中的实现、独立审查、已有检查和集成步骤抽象的公式；本仓库 [public-boundary.yml](../../.github/workflows/public-boundary.yml) 提供已有检查步骤的具体来源，不能视为该 CI 文件被自动转换或执行过。v2 明确要求独立意见，v1 的既有合同不自动升级；所需的受限意见仍是审查者判断，不证明业务正确或检查通过。真实项目实例尚未贯通。

## 启动配置与能力边界

默认不准入新的 Factory 工作。要在经授权的服务器上启用，须由服务端配置 `AGENTOC_FACTORY_SCHEDULER_ENABLED=1`、`AGENTOC_FACTORY_ORGANIZATIONS` 逗号分隔组织白名单和 `AGENTOC_FACTORY_SCHEDULER_OWNER_ID` 授权来源；后台使用受限 scheduler 服务主体，不把请求体中的身份当作 owner。每个组织还须有正整数 `policy.factoryMaxConcurrent`、明确的运行次数/Token/成本预算，并启用现有 Governor。组织节点须具备当前有效的 run 授权，写任务还须具备覆盖其路径的 write 授权。关闭新准入后，配置了组织和授权来源的服务仍可观察并对账已有执行；关闭服务本身不会继续计算。

`accessMode: read` 表示候选输入只读任务，`accessMode: write` 的交付路径必须处于节点写入授权内；候选范围不自动扩充写权限。执行复用共享 broker，实际工作目录和受限输入由任务绑定；不声称共享进程提供操作系统级隔离。候选暂限 1,000 个文件、32 MiB 范围，拒绝符号链接及缓存/构建目录；可通过拆小授权范围处理，不能静默截断。未知用量保留预算预留；只有可归属该 Run 的完整 provider 实际用量才能结算。上述配置和实现均未在真实项目或重启恢复中验证，本次没有在本机启用。

`AGENTOC_FACTORY_SHADOW_SYNC_ENABLED=1` 可在既有 observer 循环按组织白名单启用只读来源的分页 shadow 投影；默认关闭。水位与快照同事务写入，不启动 Run、不发消息、不把旧成功当验收。仅映射明确声明组织且同项目或项目缺失的 Collaboration；未关联组织及跨库 Run/Packet 的真实性仍需人工核对。完成一轮的时间不等于业务验收通过。

备份工具只覆盖三个 SQLite 数据库，使用数据库写锁检查已知活动项；不复制 Run 文件或项目产物，也不证明外部副作用已停止。只读连接在 WAL 模式下仍可能创建或更新源目录的共享内存文件；工具未实际运行，不能据此声称恢复已验证。

本次工作区的存储约束：工作产物、临时目录及可变缓存留在 `G:/AgentoC`；这不是对产品其他用户的盘符要求。不清理其他并行任务或用户数据。最近核查 G: 可用 6,945,722,368 字节（约 6.47 GiB），变化原因未确定。既有检查留下 `G:/AgentoC/temp/team-control-check/agentoc-org-projection-v2-FGb7XY`（约 356,352 字节）和 `G:/AgentoC/temp/agentoc-autonomous-org-s22-0UFE7H`（约 327,680 字节），另有空的 factory-check-work 目录；数据合计约 684,032 字节，不足 1 MiB。此前精确清理被自动策略阻止，未绕过重试，上述残留仍保留。
