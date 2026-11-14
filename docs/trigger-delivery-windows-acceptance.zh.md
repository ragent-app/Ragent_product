# 提醒整改：Windows 隔离验收记录

日期：2026-11-14（北京时间）

验收使用当前工作树启动 G 盘专用隔离实例，未更新或重启现有生产服务。源码 HEAD `baf143c3ecfe823e1dadc52f6ea2045e3e1d5c91` 包含 `bf1ba74a`；测试时 `chat-server.mjs` 和 `chat/run-launcher.mjs` 还包含其他任务既有未提交修改，因此它不是纯净提交快照。启动时文件摘要及脱敏事件记录保存在 `G:/AgentoC/_qa/trigger-acceptance-20261113/`。

第一次在没有 Windows runner broker 的隔离实例触发专用提醒，调度状态为 `delivered`，关联 Run 为 `accepted`、交付为 `pending`，但 Run 的失败原因已显示必须有 broker，30 秒后仍未收敛。这个环境未到达 provider 准备阶段，也不是原始用户事故的复现。

随后修正明确未提交的本地拒绝分类，在新实例重复该真实路径。提醒于 2026-11-13 16:00:28 UTC 触发；16:01:14 UTC（46 秒后）检查：提醒 `failed`，执行 `failed`，交付 `unknown`，attempts 为 1，仍关联同一 failed Run；触发记录保留 `WINDOWS_RUNNER_BROKER_REQUIRED`。Run 的错误文本保留原因，但其 result 未保存该错误码。此结果验证该特定拒绝路径及观察窗口内没有重复尝试，不能证明其他失败路径或长期行为。

隔离 launcher 现为独立实例设置 G 盘 harness 根。其旧版只生成静态 token，而当前服务已停用静态 token 登录；本次使用产品的 Windows owner 初始化函数为隔离实例生成独立测试密码，再通过正式登录访问。一次为第二隔离实例创建的设备 OAuth job 在用户授权前通过正式接口取消；没有复制或更改现有用户凭据。

生产安装载荷不是本次代码：六个相关 JavaScript 文件与验收工作树的摘要不同。以默认安装发现路径访问时返回 `OBD_RELEASE_NOT_INSTALLED`；只读指定实际安装根 `G:/AgentoCapp` 后返回 `OBD_OBJECT_WRITABLE_BY_FOREIGN_IDENTITY`，未改权限或绕过校验。当前未取得可靠的生产活跃 Run 列表，不能推断重启安全。

上述发现是当时的历史记录。用户随后明确要求保留 G 盘 `Users` 完全控制权限，并删除安装根之外的祖先目录不得由普通身份写入的产品要求；安装根与载荷本身仍需受保护。此前提出的收紧 G 盘根 ACL 草案已废止，不应执行。源码策略变更是否修复实际安装的发现问题，须以只读诊断和正式部署后的结果分别判断；源码变化不会自动更新现有安装载荷。

修改后的源码 discovery 对 `G:/AgentoCapp` 做一次只读检查，返回 `OBD_ENDPOINT_UNAVAILABLE`：检查越过原祖先写入错误，但 live endpoint 未通过发现。所用源码脚本 SHA-256 为 `4E0FA1DC798A414E1BFACF12609884493B39094988C063F2A1F12593EA7EFC0C`，当前安装的 owner helper SHA-256 为 `F527633346B99E90328971D08C65F13299539FA7E276B051CB2200230E56FD58`。这是源码脚本对现有安装的检查结果，不代表现有安装已更新或 owner 通道可用。各产品根检查仍保留各自原有 ACL 掩码及其他对象身份、内容验证。

真实 provider 成功回复、周期提醒、控制面重启恢复、MCP 超时和原始事故因果均未完成验收。隔离实例缺少正式 Windows supervisor；未以模拟 provider 或放宽身份校验替代。当时尚未推送或部署。

## 正式升级尝试（2026-11-14）

基于提交树 `082be1014990eddc942bbc7d676ffa4f524b4971` 构建 MSI 0.0.83，SHA-256 `2534E8A2E511C936B65E88FF524E3C8410E77F2EB8B5160D0B1B9B0332A774D0`。第一次构建因默认缓存的 PowerShell 7.6.6 压缩包摘要不符而失败；重新构建明确指定现有 verified 缓存，其摘要与项目固定值及官方发布摘要一致，未修改期望值。

候选包正式 upgrade-admission 返回成功。进入产品维护 drain 并核对 Run 索引及状态后，执行同路径升级；旧包的 `ManagedRemoveGuard` 在 `RemoveExistingProducts` 中失败，MSI 返回 1603。旧注册 MSI 提取的原 bridge（SHA-256 `89DD08D89725A0FB880352306C6A014FF06A1D07AA1E81C2501BDD90FF83A7FB`）对相同安装路径执行一次源码标明只读的 remove-admission，返回 `OMI_INPUT_WRITABLE`；该码不能单独确定具体对象，也不能证明诊断与 MSI 操作令牌完全相同。

已通过产品入口解除 drain；旧版 0.0.82 仍注册，两个核心服务仍以原 PID、身份和实例路径运行，三个关键载荷摘要与升级前一致。这些是局部连续性证据，不代表完整回滚：日志在 Broker 回滚动作执行时记录 `Error in rollback skipped. Return: 5`，具体原因未明。未修改 G 盘根 ACL，未再次安装。日志与候选包位于 `G:/AgentoC/_qa/msi-remediation-20261114/`；真实 provider、周期提醒和生产重启恢复仍未验收。

同日评估并构建正式 minor 路线：冻结源码 `0c9719da100dc26034f3c801632e2b811517f237`，保留旧 ProductCode、使用 0.0.83，绑定旧 MSI SHA-256；minor MSI SHA-256 `9ED9EEF79C0FF071A98E205DDB06811CDC76ECB72096C7779DB90390A72FE04D`。构建自带的组件树检查通过，且确认不运行 RemoveExistingProducts；包内正式准入也通过。

第一次 minor 安装在 ProcessComponents 失败（1603）：SecureRepair 根据已注册包名寻找 `AgentoC.msi`，候选目录没有该名称。按产品 Setup 的同内容别名机制建立硬链接并核对摘要后，重新进入 drain、核对 100 个索引及目录均为终态，再执行一次正式 minor 事务。MSI 返回 3010：升级成功但需要重启；日志记录的待重启操作为删除一个 MSI 回滚文件，不能据此推断系统其他待重启操作。未重启系统。新版本 0.0.83 已注册，两个服务恢复运行且实例路径和服务身份不变；安装的 triggers、run-launcher 和 discovery 文件的 Git blob 与冻结源码一致。已通过正式入口解除 drain。真实 provider 和提醒链路验收结果另行记录。

新安装的 ServiceHost SHA-256 为 `EA4C3ECDE55528D0495CB18FE6DD33951A7A32D50769584E2199A85A2CFD3186`；MSI 事务完成且两个新服务进程运行，但未从包内独立提取 ServiceHost 做逐字节摘要比较。部署后正式安装 CLI 的 owner activation、discovery 和认证只读链路成功，provider 配置投影为 enabled/credentialOk，表示本地配置和凭据可读取，不能单独证明上游可用。

部署后的真实一次性提醒使用专用会话，provider 准备 ready/verified，Run completed 且退出码为 0；只读持久记录显示该 occurrence 的 execution 为 completed、delivery 为 published。专用会话中关联同一 Run 的 assistant 消息 seq 5 正文为“提醒验收成功。”，与请求一致。这验证一次真实回复的持久发布；未直接观察用户界面，也未证明周期提醒、重启恢复或 MCP 失败路径。

随后 owner CLI 出现 `OBC_PEER_DISCONNECTED` 和 `OBC_TRANSPORT_FAILED`；只读健康端点返回 HTTP 503，owner activation 为 failed、code `OSV_RECOVERY_REFUSED`。两核心服务仍在运行；当前原因及恢复尚待确认，不能将 Run 成功视为 owner 通道持续健康。

为保留 owner 恢复失败的后续诊断，正式部署 minor 0.0.84：源码 `acc74f99f2fce580e253f2fd5092e3ee05a2e062`，MSI SHA-256 `B1A6ADD2E3F341801966102BE55250EE33CDB5CAD6405CBC2401543105EB6050`；组件兼容检查及正式准入通过。升级前 drain 下 101 个索引和 Run 目录一致且均为终态；安装返回 3010，版本已注册，三个诊断文件 blob 与源码一致，两个服务恢复运行，drain 已解除。本事务记录重启后删除 MSI 回滚文件，未重启计算机。

部署后一次正式 owner 健康检查为 listening/ready，CLI provider 读取成功。此次部署增加受限诊断信息，不改变恢复安全屏障，也不能证明此前 `OSV_RECOVERY_REFUSED` 的根因已修复；需在真实重现时读取新诊断。

0.0.84 上创建的专用周期提醒按两次上限结束并自动禁用。首轮 Run 在 provider 准备 ready/verified 后出现真实 `MCP_READINESS_TIMEOUT`，execution failed、delivery unknown；持久 spool 记录 readiness 等待 15000 毫秒且未观察到 ready 状态。第二轮 Run completed、delivery published，正式 history API 返回同一 Run 的 assistant 消息 seq 13，正文为“周期提醒验收成功。”。两轮使用不同 requestId，均为一次尝试；未观察用户界面。这支持每轮请求和结果隔离；首轮失败意味着两轮全成功验收未通过，原因仍待定位，第二轮成功不代表首轮自动恢复。

补充的 MCP 只读诊断将失败记录写入该 Run 的 spool，包含 inventory 状态、首个必需目标是否出现、受限就绪原因和等待时长，不改变就绪判断。现有 sidecar 检查在第 939 行权限模式断言失败；该用例输入与期望不一致，但未运行基线，不能据此断言失败与改动无关。排队验收未命中：背景 Run 先因 MCP 超时结束，后续提醒直接运行，不能视为 queued 已验证。

为采集真实 MCP 启动失败的有限诊断，已将提交 `1be543829d32a21ed6091d1708e8429d2c8eb356` 构建为 minor 0.0.85，MSI SHA-256 `8098193FD4C4E46AAFC89E1AC087CD102065B077E84623FDB29170478A43E4E7`。组件兼容及正式准入通过；升级前 drain 下 105 个索引和 Run 目录一致且均为终态。安装返回 3010，0.0.85 已注册，安装的 sidecar blob 与提交一致，两核心服务运行、drain 已解除。本次日志记录重启后删除 MSI 回滚文件，未重启系统。该版本仅增加失败诊断，不声明 MCP 超时根因已修。

0.0.85 上的一次专用真实提醒再次以 `MCP_READINESS_TIMEOUT` 失败，execution failed、delivery unknown。新增 spool 诊断显示 inventory 已响应、首个目标存在，但 readiness 仍为 waiting / `MCP_READY_UNCONFIRMED`，等待约 15002 毫秒且未观察到目标 ready 状态；这不证明目标进程未启动或其退出原因。当前 MCP 问题仍未解决。

对 0.0.85 失败 Run 的既存 inventory 做限定投影，目标服务器的 `runtimeStatus` 为 `connected`，目标工具存在且其输入 schema 的类型为 object。该事实缩小了问题范围：等待 ready 并不表示目标服务器未连接。早先现场投影因枚举列表不完整将该值标为 other，后经完整枚举更正；不得据此推断运行时字段为对象。

后续修正解析并评估 inventory 的 `connected` 状态，并限定关联合法 MCP 通知；这针对已观察到的 connected 状态未被使用的问题。现有 broker 检查通过；adapter 检查在第 39 行权限参数断言失败，未做基线复跑，不能称全项通过或断言归因。实际提醒链路须在部署后验收；broker 路由是否造成此前通知缺失仍未证实。

正式 minor 0.0.86 基于提交 `92bd96166e60494c64beee6b04496eb7ea49af9c`，MSI SHA-256 `747130669D8C41DF31CACCFFBA34FF69D90E4E0B350CE6DD3BBF2C270071D029`；组件兼容和正式准入通过。维护 drain 下 106 个索引及目录一致且均终态。安装返回 3010，版本已注册，三处 MCP 修复文件安装 blob 与提交一致，两核心服务运行且 drain 已解除。本事务日志记录重启后删除 MSI 回滚文件，未重启系统；真实业务结果须另验收。

0.0.86 部署后，正式 owner health 为 listening/ready，CLI 只读成功。专用一次性提醒 Run completed/published；其最终 assistant 持久消息 seq 31 精确为“修复后提醒验收成功。”。该 Run 的 inventory 记录目标 `connected`、必需工具存在、readiness verified，未见目标 startup 通知；这支持 connected 状态修复的真实路径，不证明通知路由修复被触发。

同一环境的专用周期提醒两轮均 completed/published，达到上限后自动禁用；两轮对应最终 assistant 持久消息 seq 36 和 41 均为“修复后周期提醒验收成功。”。未直接观察用户界面；排队及控制面重启期间跟踪恢复仍需独立证据。

控制面重启后的 pending 恢复已用专用单次提醒验证：到期前全量 Run 索引和目录 111/111 一致且均终态，正常重启仅 ControlPlane（PID 262640→247988），RunnerSupervisor PID 149628 保持运行。同一提醒在重启后自然到期，单次尝试后 Run completed、delivery published 并自动禁用；同一 Run 的持久 assistant 消息 seq 55 为“重启后提醒验收成功。”。这只验证 pending 调度恢复；排队和已受理 Run 的在途 tracking 重启恢复尚未命中。历史 `OSV_RECOVERY_REFUSED` 的根因尚未确定，后续健康恢复不证明根因修复；无 threadId 的 broker 通知路由也未在真实事件中单独验证。

进一步验收捕获到真实 queued 提醒，并在背景专用 Run 仍运行、仅该 QA Run 活跃时正常重启 ControlPlane；Supervisor 保持原 PID。原 occurrence 重启后关联的 Run 长时间 accepted 且未启动，随后正式对账将其判为 failed/unknown，未重发。静态定位发现 queue flush 的 skipDispatch 同时阻止了 runner 启动；已将调度规划与内部不启动 runner 的选项分离。现有 session-dispatch 与单项 derived 检查通过，follow-up fixture 因 unknown Harness、resend 因 EXECUTION_SCOPE_STALE 未通过，不能称所有检查通过；修复须部署后重新验证。

0.0.87 基于 `7a7cfcabbb22bc1b4d5228df3b18db5d9ee01e66` 正式 minor 安装，MSI SHA-256 `5704093FDCD123F1CE01FF0067FDF18C1DA386B2175C843A8FF1905A9753BA70`。安装返回 3010，注册版本及 session-manager 安装 blob 已核对，两服务运行且 drain 已解除。真实队列验收捕获 queued，原 occurrence 后续启动同 request 的 Run 并 completed/published、attempt 1；对应持久 assistant seq 92 正文为“队列修复恢复验收成功。”。该轮核重启条件时 Run 已终态，未重启，只验证队列自然推进，不证明在途重启恢复。

随后单条真实只读审查提醒的 Run 已启动但很快 failed，触发结果为 failed/published，错误 `delegation_replay_invalid`；其持久回复存在不等于任务成功，此轮未重启。有限取证发现新版 Codex 的 wait 调用以工具调用 ID 被误当作子代理 ID；后续源码将带新协议 receiverThreadIds 的 wait 作为控制观测，保留已知活跃子代理安全屏障。随后同 Run 按已确认的父 thread 和 receiver 映射成功 spawn 及明确 child 终态；跨 Run 关联和真实 spawn 尚未验收。该修复尚需正式安装与真实验收。两项既有权限检查已按实际测试场景修正，作者分别运行通过，未更改产品权限策略。

历史 owner `OSV_RECOVERY_REFUSED` 的首因、历史 major 回滚 Return 5 的原因、无 threadId 的 broker 通知真实覆盖及用户界面观察仍未闭环；pending 调度重启已验证，已受理 Run 的在途重启恢复仍未验证。所有结论以实际记录为限。
