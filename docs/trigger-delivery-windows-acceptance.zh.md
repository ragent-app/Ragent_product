# 提醒整改：Windows 隔离验收记录

日期：2026-11-14（北京时间）

验收使用当前工作树启动 G 盘专用隔离实例，未更新或重启现有生产服务。源码 HEAD `baf143c3ecfe823e1dadc52f6ea2045e3e1d5c91` 包含 `bf1ba74a`；测试时 `chat-server.mjs` 和 `chat/run-launcher.mjs` 还包含其他任务既有未提交修改，因此它不是纯净提交快照。启动时文件摘要及脱敏事件记录保存在 `G:/AgentoC/_qa/trigger-acceptance-20261113/`。

第一次在没有 Windows runner broker 的隔离实例触发专用提醒，调度状态为 `delivered`，关联 Run 为 `accepted`、交付为 `pending`，但 Run 的失败原因已显示必须有 broker，30 秒后仍未收敛。这个环境未到达 provider 准备阶段，也不是原始用户事故的复现。

随后修正明确未提交的本地拒绝分类，在新实例重复该真实路径。提醒于 2026-11-13 16:00:28 UTC 触发；16:01:14 UTC（46 秒后）检查：提醒 `failed`，执行 `failed`，交付 `unknown`，attempts 为 1，仍关联同一 failed Run；触发记录保留 `WINDOWS_RUNNER_BROKER_REQUIRED`。Run 的错误文本保留原因，但其 result 未保存该错误码。此结果验证该特定拒绝路径及观察窗口内没有重复尝试，不能证明其他失败路径或长期行为。

隔离 launcher 现为独立实例设置 G 盘 harness 根。其旧版只生成静态 token，而当前服务已停用静态 token 登录；本次使用产品的 Windows owner 初始化函数为隔离实例生成独立测试密码，再通过正式登录访问。一次为第二隔离实例创建的设备 OAuth job 在用户授权前通过正式接口取消；没有复制或更改现有用户凭据。

生产安装载荷不是本次代码：六个相关 JavaScript 文件与验收工作树的摘要不同。以默认安装发现路径访问时返回 `OBD_RELEASE_NOT_INSTALLED`；只读指定实际安装根 `G:/AgentoCapp` 后返回 `OBD_OBJECT_WRITABLE_BY_FOREIGN_IDENTITY`，未改权限或绕过校验。当前未取得可靠的生产活跃 Run 列表，不能推断重启安全。

真实 provider 成功回复、周期提醒、控制面重启恢复、MCP 超时和原始事故因果均未完成验收。隔离实例缺少正式 Windows supervisor；未以模拟 provider 或放宽身份校验替代。尚未推送或部署。
