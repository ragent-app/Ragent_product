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
